/**
 * SpaceWorker interactive-browser subsystem (Task 7, Phase 1).
 *
 * A SEPARATE process from the main Next.js app — run via tsx under the
 * `spaceworker-browser.service` systemd unit, listening on 127.0.0.1 only,
 * gated by the BROWSER_SERVER_TOKEN bearer secret. It owns the real Chrome/Neko
 * browser footprint (never the Next.js process — PLAN.md §197) and keeps the
 * in-app `userId -> (pid, container)` process registry the admin kill-switch
 * reads from.
 *
 * Streaming contract (deploy-side — see browser-server/README.md): each session
 * gets its own Neko container exposing its web client on a per-session host
 * port; the VPS front reverse-proxies `${APP_BASE_URL}/browser/<sessionId>/`
 * (including the WebSocket upgrade) to that port. The app records the port this
 * server returns and the dashboard panel iframes the connect URL.
 *
 * SPIKE SURFACE: the exact Neko image/env/volume invocation in buildNekoArgs()
 * is what must be validated against a real container on the VPS before relying
 * on it (see the spike checklist at the bottom of this file). The process-
 * management layer around it (registry, kill, stop, restart) is ordinary
 * child_process code and needs no spike.
 */
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { resolve } from "path";
import { chmod, mkdir, readdir, rm, writeFile } from "fs/promises";
import httpProxy from "http-proxy";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.BROWSER_SERVER_PORT ?? 3401);
const HOST = process.env.BROWSER_SERVER_BIND ?? "127.0.0.1";
const TOKEN = process.env.BROWSER_SERVER_TOKEN;
// Confirmed live on the VPS 2026-09-04: GHCR's current path is a nested repo
// name (neko/chromium), not the old colon-tag form (neko:chromium) — the
// latter is denied ("error from registry: denied") since that repo/tag no
// longer resolves under m1k1o/neko directly.
const NEKO_IMAGE = process.env.BROWSER_NEKO_IMAGE ?? "ghcr.io/m1k1o/neko/chromium:latest";
const HOST_PUBLIC_IP = process.env.BROWSER_HOST_PUBLIC_IP ?? "";
// TURN relay for WebRTC media — confirmed live 2026-09-08: STUN alone (the
// only thing previously configured) lets two peers exchange candidates but
// can't get media through when either side is behind a NAT that STUN can't
// traverse (common on corporate/some mobile networks) — the exact "stuck on
// Neko's connecting spinner, or the session silently drops to Neko's own
// login screen on reconnect" symptom reported live. A TURN relay is the
// standard fix: it gives both sides a guaranteed-reachable relay path when
// direct/STUN-assisted connection fails. Optional — if unset, sessions still
// work over STUN-only exactly as before (no regression for the common case).
const TURN_HOST = process.env.BROWSER_TURN_HOST ?? "";
const TURN_PORT = process.env.BROWSER_TURN_PORT ?? "3478";
const TURN_USERNAME = process.env.BROWSER_TURN_USERNAME ?? "";
const TURN_PASSWORD = process.env.BROWSER_TURN_PASSWORD ?? "";

function buildIceServersJson(): string {
  const servers: Array<Record<string, unknown>> = [{ urls: ["stun:stun.l.google.com:19302"] }];
  if (TURN_HOST && TURN_USERNAME && TURN_PASSWORD) {
    servers.push({
      urls: [`turn:${TURN_HOST}:${TURN_PORT}`],
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    });
  }
  return JSON.stringify(servers);
}
const BASE_PORT = Number(process.env.BROWSER_SESSION_BASE_PORT ?? 32000);
// WebRTC media (the actual video/audio stream) needs its own UDP port range —
// distinct from Neko's single TCP signaling/web port (8080, mapped per-session
// above). Each concurrent session needs a NON-overlapping range published to
// the host, since `-p X-Y:X-Y/udp` binds those exact host ports — two
// containers can't both publish 52000-52100. 20 ports/session comfortably
// covers Neko's real usage and fits MAX_CONCURRENT_SESSIONS (3) inside the
// documented default block with headroom.
const EPR_BASE = Number(process.env.BROWSER_NEKO_EPR_BASE ?? 52000);
const EPR_WIDTH = Number(process.env.BROWSER_NEKO_EPR_WIDTH ?? 20);

interface Session {
  sessionId: string;
  userId: string;
  profileDir: string;
  proxyServerValue: string;
  pid: number | null;
  containerName: string | null;
  port: number | null;
  eprRange: string | null; // "start-end" UDP range for this session's WebRTC media
  status: string; // "starting" | "running" | "stopped"
  startedAt: number;
  // Neko's own login gate (separate from our app's auth) — generated once
  // per container and passed through so the frontend can auto-login via
  // Neko's documented ?usr=&pwd= URL params instead of showing customers a
  // login screen for a password they were never given (a real gap: this was
  // previously generated fresh inside buildNekoArgs() and discarded
  // immediately after building the docker args, never reaching the client).
  nekoPassword: string | null;
}

const registry = new Map<string, Session>();
let portCursor = 0;

function allocatePort(): number {
  return BASE_PORT + portCursor++;
}

// Same cursor as allocatePort() — one session's TCP web port and its UDP
// media range are allocated together, so they stay in lockstep and never
// drift out of sync across restarts.
function allocateEprRange(): string {
  const start = EPR_BASE + (portCursor - 1) * EPR_WIDTH;
  const end = start + EPR_WIDTH - 1;
  return `${start}-${end}`;
}

function containerName(sessionId: string): string {
  return `spaceworker-browser-${sessionId}`;
}

// CONFIRMED LIVE 2026-09-07: NEKO_BROWSER_ARGS is NOT read by this image at
// all — ghcr.io/m1k1o/neko/chromium bakes a FIXED, hardcoded Chromium command
// line into /etc/neko/supervisord/chromium.conf at build time (loaded via
// supervisord's `[include] files=/etc/neko/supervisord/*.conf`). Verified by
// launching a real session with NEKO_BROWSER_ARGS set and inspecting the
// actual running Chromium process's argv inside the container: no
// --proxy-server flag anywhere, despite the container's own shell having
// live, working connectivity to that exact proxy address. Every exit-node
// selection has therefore been a silent no-op for real browsing traffic
// since this feature was built — sessions always went direct.
// Fix: generate a per-session copy of that same conf file with
// --proxy-server appended, and bind-mount it over the image's built-in one
// (supervisord reads whatever's on disk at container start, so a host-side
// bind mount is sufficient — no image rebuild needed).
const SESSION_TMP_DIR = resolve("browser-sessions-tmp");

function chromiumConfDir(sessionId: string): string {
  return `${SESSION_TMP_DIR}/${sessionId}`;
}

function buildChromiumSupervisorConf(proxyServerValue: string): string {
  // CONFIRMED LIVE 2026-09-08: if Chromium exits uncleanly on its very first
  // launch inside a fresh container for ANY reason, it leaves its own
  // SingletonLock/-Cookie/-Socket behind. supervisord's `autorestart=true`
  // then relaunches it immediately, Chromium sees ITS OWN stale lock from
  // the previous attempt, refuses to start ("profile appears to be in use by
  // another Chromium process"), and this repeats forever -- a permanent
  // crash-loop for the rest of that container's life, with no session ever
  // actually coming up (Neko has nothing to show, so the viewer just sees
  // its own connecting/loading state indefinitely). The Node-side
  // cleanupProfileDir() only runs BEFORE the container starts -- it has no
  // visibility into supervisord's internal restart loop once the container
  // is already up. Fix: wrap the launch in a shell one-liner that clears
  // those exact lock files immediately before every single attempt,
  // including supervisord's own internal restarts, not just the first one.
  const flags = [
    "--no-sandbox",
    "--window-position=0,0",
    "--display=%(ENV_DISPLAY)s",
    "--user-data-dir=/home/neko/.config/chromium",
    "--no-first-run",
    "--start-maximized",
    "--bwsi",
    "--force-dark-mode",
    "--disable-file-system",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-dev-shm-usage",
  ];
  if (proxyServerValue) {
    flags.push(`--proxy-server=${proxyServerValue}`);
  }
  const launchCmd = `rm -f /home/neko/.config/chromium/Singleton* && exec /usr/bin/chromium ${flags.join(" ")}`;
  return [
    "[program:chromium]",
    'environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"',
    `command=/bin/sh -c "${launchCmd}"`,
    "stopsignal=INT",
    "autorestart=true",
    "priority=800",
    "user=%(ENV_USER)s",
    "stdout_logfile=/var/log/neko/chromium.log",
    "stdout_logfile_maxbytes=100MB",
    "stdout_logfile_backups=10",
    "redirect_stderr=true",
    "",
  ].join("\n");
}

/**
 * Writes this session's chromium.conf to a scratch dir and returns its host
 * path, or null for a direct (no exit node) session — in which case nothing
 * is mounted and the image's own built-in conf is used unchanged, keeping
 * direct sessions byte-for-byte the same as before this fix.
 */
async function prepareChromiumConf(session: Session): Promise<string | null> {
  if (!session.proxyServerValue) return null;
  const dir = chromiumConfDir(session.sessionId);
  await mkdir(dir, { recursive: true });
  const confPath = `${dir}/chromium.conf`;
  await writeFile(confPath, buildChromiumSupervisorConf(session.proxyServerValue), "utf8");
  return confPath;
}

async function cleanupChromiumConf(sessionId: string): Promise<void> {
  await rm(chromiumConfDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

/** Docker/Neko launch — THE spike surface. Built as an arg array, never shell-joined. */
function buildNekoArgs(session: Session, chromiumConfPath: string | null): string[] {
  const password = randomBytes(9).toString("base64url");
  session.nekoPassword = password; // stored so the frontend can auto-login — see Session.nekoPassword
  const profileMount = `${session.profileDir}:/home/neko/.config/chromium`;
  const args: string[] = [
    "run",
    "-d",
    "--rm",
    "--name", session.containerName!,
    "-p", `${session.port}:8080`,
    // WebRTC's actual media stream (not the signaling websocket, which rides
    // the TCP port above) needs this UDP range PUBLISHED to the host, or
    // Neko's ICE candidates have no path in from the internet at all — the
    // symptom is Neko's own "connecting" splash spinning forever with no
    // error, since the signaling connection succeeds fine and only the media
    // stream silently never arrives. Confirmed missing here (2026-09-05):
    // NEKO_EPR was previously set without a matching `-p` publish.
    "-p", `${session.eprRange}:${session.eprRange}/udp`,
    "-v", profileMount,
    "-e", `NEKO_PASSWORD=${password}`,
    "-e", `NEKO_PASSWORD_ADMIN=${password}`,
    "-e", `NEKO_PROXY=default`,
    "-e", `NEKO_SCREEN=1280x720@30`,
    "-e", `NEKO_EPR=${session.eprRange}`,
    "-e", `NEKO_WEBRTC_ICESERVERS_FRONTEND=${buildIceServersJson()}`,
    "-e", `NEKO_WEBRTC_ICESERVERS_BACKEND=${buildIceServersJson()}`,
  ];
  if (chromiumConfPath) {
    args.push("-v", `${chromiumConfPath}:/etc/neko/supervisord/chromium.conf:ro`);
  }
  if (HOST_PUBLIC_IP) {
    // Without this, Neko advertises the container's internal Docker IP as its
    // ICE candidate — unreachable from any real client, same silent-forever-
    // spinner symptom as the missing `-p` above. Confirmed unset on the VPS
    // (2026-09-05) — see browser-server/README.md for the required .env fix.
    args.push("-e", `NEKO_NAT1TO1=${HOST_PUBLIC_IP}`);
  }
  args.push(NEKO_IMAGE);
  return args;
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args, { timeout: 120_000 });
  if (args[0] === "run" || args[0] === "create") {
    return stdout.split("\n")[0]?.trim() ?? "";
  }
  return stdout.trim();
}

async function waitRunning(container: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    try {
      const state = (await docker("inspect", "-f", "{{.State.Running}}", container)).trim();
      if (state === "true") return true;
    } catch {
      /* still baking — keep polling */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Docker's own "Running" state only means the container's entrypoint process
// started — it says nothing about whether Neko's web/WebSocket server INSIDE
// the container has actually finished booting (it launches Chromium first,
// which can take several more seconds). Marking status "running" right after
// waitRunning() — as this used to do — told the frontend to connect before
// the stream was actually ready, surfacing as "Session stream unavailable"
// (confirmed: the exact error text the httpProxy error handler below
// returns) even though the session would have worked fine a few seconds
// later. This polls the actual mapped port until Neko answers.
function waitPortReady(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const req = httpGet({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
        res.resume(); // drain so the socket can close cleanly
        resolvePromise(true);
      });
      req.on("error", () => {
        if (Date.now() >= deadline) {
          resolvePromise(false);
        } else {
          setTimeout(attempt, 500);
        }
      });
      req.on("timeout", () => req.destroy());
    };
    attempt();
  });
}

// Chromium creates its own subdirectories/files inside the profile mount using
// its own default (restrictive, owner-only) permissions — the one-time
// chmod 777 applied when a profile is first created (lib/browser-profiles.ts)
// only covers the top-level directory, not content Chromium writes afterward.
// If a LATER container run happens to use a different effective uid (e.g. an
// image update, or any host-side process touching the directory), those
// owner-only subdirectories become unwritable, and Chromium crash-loops with
// "mkdir ... Permission denied" (confirmed live via a diagnostic container run
// on 2026-09-04). A killed/crashed container can also leave behind Chromium's
// SingletonLock/-Cookie/-Socket files, which then make every future launch
// fail with "profile appears to be in use by another Chromium process" even
// though nothing is actually still running. Run before every start so a
// profile heals itself regardless of how the previous session ended.
async function cleanupProfileDir(profileDir: string): Promise<void> {
  try {
    await chmod(profileDir, 0o777);
    const entries = await readdir(profileDir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith("Singleton"))
        .map((name) => rm(`${profileDir}/${name}`, { force: true }).catch(() => {})),
    );
    await execFileAsync("chmod", ["-R", "777", profileDir]).catch(() => {});
  } catch {
    // Best-effort — a permission/lock problem this can't fix will still
    // surface clearly via the container's own crash logs.
  }
}

async function startInternal(session: Session): Promise<string> {
  await cleanupProfileDir(session.profileDir);
  const entry = registry.get(session.sessionId);
  if (entry && entry.status === "running") {
    return entry.containerName ?? ""; // idempotent
  }
  session.pid = process.pid; // registry owner; real work lives in the docker container
  session.containerName = containerName(session.sessionId);
  session.port = allocatePort();
  session.eprRange = allocateEprRange();
  session.status = "starting";
  registry.set(session.sessionId, session);

  const chromiumConfPath = await prepareChromiumConf(session);

  // A proxied session's whole path (Chromium -> exit-node SOCKS proxy -> real
  // WireGuard tunnel to a free-tier VPN server) has a real, confirmed-live
  // failure mode that plain "direct connection" sessions never hit: the
  // free-tier VPN node can have brief, intermittent stalls (verified
  // 2026-09-07 — the exact same proxy address alternated between working and
  // timing out seconds apart, no code or config change in between). If that
  // stall happens to land inside this container's Chromium cold-start
  // window, the whole session fails even though the proxy is fine moments
  // later. One retry with a fresh container gives a second, independent
  // window rather than failing outright on what's often a transient blip —
  // this is NOT a fix for the underlying VPN node's reliability (that's a
  // real, separate, ongoing limitation of the free tier), just resilience
  // against the specific timing collision.
  const MAX_LAUNCH_ATTEMPTS = session.proxyServerValue ? 2 : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt++) {
    try {
      const id = await docker(...buildNekoArgs(session, chromiumConfPath));
      if (!id) {
        throw new Error("docker did not return a container id");
      }
      if (!(await waitRunning(session.containerName))) {
        throw new Error("container never reached running state");
      }
      // Container process is up, but Neko's own web server inside it may still
      // be booting (Chromium startup) — wait for the actual stream port to
      // answer before telling the frontend it's safe to connect. 20s budget:
      // generous enough for a slow Chromium cold-start, short enough that a
      // genuinely broken container still fails within a reasonable UI wait.
      if (!(await waitPortReady(session.port, 20_000))) {
        throw new Error("Neko's stream server never became reachable on its mapped port");
      }
      session.status = "running";
      registry.set(session.sessionId, session);
      return id;
    } catch (e) {
      lastErr = e;
      // best-effort cleanup so a failed attempt never leaves an orphaned
      // container behind, whether or not this was the last attempt
      await docker("rm", "-f", session.containerName).catch(() => {});
    }
  }
  session.status = "stopped";
  session.containerName = null;
  registry.set(session.sessionId, session);
  await cleanupChromiumConf(session.sessionId);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function stopInternal(sessionId: string, force: boolean): Promise<void> {
  const entry = registry.get(sessionId);
  if (!entry) {
    // unknown locally — clean anything we may have half-launched
    await docker("rm", "-f", containerName(sessionId)).catch(() => {});
    await cleanupChromiumConf(sessionId);
    return;
  }
  if (entry.containerName) {
    await docker("rm", "-f", entry.containerName).catch(() => {});
  }
  await cleanupChromiumConf(sessionId);
  // Heal the profile on every stop too, not just on the next start — a
  // service restart (systemctl restart spaceworker-browser) kills every live
  // container out from under this process without ever calling stopInternal,
  // which is exactly why startInternal ALSO cleans up defensively; this call
  // covers the normal stop path so a clean stop never leaves stale locks.
  await cleanupProfileDir(entry.profileDir);
  entry.pid = null;
  entry.containerName = null;
  entry.status = "stopped";
  if (force) {
    registry.delete(sessionId);
  } else {
    registry.set(sessionId, entry);
  }
}

/** --- HTTP layer --- */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function authorize(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  return TOKEN !== undefined && TOKEN.length > 0 && header === `Bearer ${TOKEN}`;
}

function publicSession(s: Session) {
  return {
    sessionId: s.sessionId,
    userId: s.userId,
    containerName: s.containerName,
    port: s.port,
    status: s.status,
    startedAt: s.startedAt,
    nekoPassword: s.nekoPassword,
  };
}

// Public browser-streaming proxy: nginx forwards ALL /browser/* traffic here
// (one static location block, no dynamic per-session config needed) and this
// process looks up the session's actual Neko container port from its own
// in-memory registry, then proxies onward — both plain HTTP (Neko's web
// assets) and the WebSocket upgrade (the real video/input stream). This path
// is reached directly by the customer's browser via nginx and deliberately
// does NOT require the internal Authorization bearer token the rest of this
// API does — there is no way for an end-user's <iframe> to carry that header.
const browserProxy = httpProxy.createProxyServer({ ws: true });
browserProxy.on("error", (err, _req, res) => {
  console.error("browser proxy error:", err);
  if (res && "writeHead" in res && !res.headersSent) {
    (res as ServerResponse).writeHead(502, { "Content-Type": "application/json" });
    (res as ServerResponse).end(JSON.stringify({ error: "Session stream unavailable" }));
  }
});

const BROWSER_PATH_RE = /^\/browser\/([a-z0-9]+)\//i;

function sessionPortForProxyPath(url: string): number | null {
  const m = BROWSER_PATH_RE.exec(url);
  if (!m) return null;
  const session = registry.get(m[1]);
  if (!session || session.status !== "running" || !session.port) return null;
  return session.port;
}

// Neko serves its own web app rooted at "/" — it has no idea it's being
// reached via our own "/browser/<sessionId>/" routing prefix. Forwarding
// req.url to the container UNCHANGED (as this used to do) means Neko sees
// e.g. "/browser/abc123/" and 404s, since it only knows about paths like
// "/" or "/api/...". Strip our prefix before proxying so Neko sees exactly
// the path it actually expects.
function stripBrowserPrefix(url: string): string {
  return url.replace(BROWSER_PATH_RE, "/") || "/";
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (url.startsWith("/browser/")) {
    const port = sessionPortForProxyPath(url);
    if (port === null) {
      json(res, 404, { error: "Session not found or not running" });
      return;
    }
    req.url = stripBrowserPrefix(req.url ?? "/");
    browserProxy.web(req, res, { target: `http://127.0.0.1:${port}` });
    return;
  }

  if (!authorize(req)) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  if (req.method === "GET" && url === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url === "/sessions") {
    json(res, 200, { sessions: [...registry.values()].map(publicSession) });
    return;
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    const sessionId = String(body.sessionId ?? "");
    if (!/^[a-z0-9]+$/i.test(sessionId)) {
      json(res, 400, { error: "Invalid sessionId" });
      return;
    }
    try {
      if (url === "/sessions/start") {
        const userId = String(body.userId ?? "");
        const profileDir = String(body.profileDir ?? "");
        // Empty proxyServerValue is valid — direct connection, no exit node.
        const proxyServerValue = String(body.proxyServerValue ?? "");
        if (!userId || !profileDir) {
          json(res, 400, { error: "userId and profileDir are required" });
          return;
        }
        const session: Session = {
          sessionId,
          userId,
          profileDir: resolve(profileDir),
          proxyServerValue,
          pid: null,
          containerName: null,
          port: null,
          eprRange: null,
          status: "starting",
          startedAt: Date.now(),
          nekoPassword: null,
        };
        const container = await startInternal(session);
        const finalSession = registry.get(sessionId);
        json(res, 200, {
          ok: true,
          containerName: finalSession?.containerName ?? null,
          port: finalSession?.port ?? null,
          containerId: container,
          nekoPassword: finalSession?.nekoPassword ?? null,
        });
        return;
      }
      if (url === "/sessions/stop" || url === "/sessions/kill") {
        await stopInternal(sessionId, url === "/sessions/kill");
        json(res, 200, { ok: true });
        return;
      }
      if (url === "/sessions/restart") {
        const entry = registry.get(sessionId);
        if (!entry) {
          json(res, 404, { error: "Session not running in this runtime" });
          return;
        }
        const profileDir = String(body.profileDir ?? entry.profileDir);
        const proxyServerValue = String(body.proxyServerValue ?? entry.proxyServerValue);
        await stopInternal(sessionId, false);
        await startInternal({
          ...entry,
          sessionId,
          profileDir,
          proxyServerValue,
          startedAt: Date.now(),
        });
        json(res, 200, { ok: true, port: registry.get(sessionId)?.port ?? null });
        return;
      }
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : "Unknown error" });
      return;
    }
  }
  json(res, 404, { error: "Not found" });
});

// Neko's real-time video/input stream is a WebSocket — proxy the upgrade the
// same way as the plain-HTTP path above, keyed by the same sessionId lookup.
server.on("upgrade", (req, socket, head) => {
  const url = (req.url ?? "/").split("?")[0];
  const port = sessionPortForProxyPath(url);
  if (port === null) {
    socket.destroy();
    return;
  }
  req.url = stripBrowserPrefix(req.url ?? "/");
  browserProxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`browser subsystem listening on ${HOST}:${PORT}`);
});

// `docker run -d --rm` detaches containers into the Docker daemon's own
// process tree — they are NOT children of this node process, so a plain
// `systemctl stop`/`restart` (SIGTERM, no handler) previously killed this
// process while leaving every live Neko/Chrome container running, orphaned,
// still consuming exactly the RAM a stop is meant to free. This was already
// half-acknowledged in stopInternal's own comment ("a service restart kills
// every live container out from under this process") but nothing actually
// tore them down — confirmed missing 2026-09-05, added for the new admin
// Services-tab Stop control specifically, where "stop this to free memory"
// needs to actually free the memory, not just block new sessions.
async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`${signal} received — tearing down ${registry.size} tracked container(s)`);
  await Promise.all(
    Array.from(registry.values())
      .filter((s) => s.containerName)
      .map((s) => docker("rm", "-f", s.containerName!).catch(() => {}))
  );
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
/**
 * SPIKE CHECKLIST (before relying on the Neko path — run on the VPS):
 *  1. `docker run -d --rm -p 32001:8080 -e NEKO_PASSWORD=x -e NEKO_PROXY=default \
 *        -v /opt/spaceworker/browser-profiles/x:/home/neko/.config/chromium \
 *        ghcr.io/m1k1o/neko:chromium`
 *  2. Confirm the web client is reachable at http://127.0.0.1:32001/ and that
 *     mouse/keyboard input actually reaches the browser (WebRTC + input fwd).
 *  3. Confirm `NEKO_BROWSER_ARGS` (or the equivalent in the current Neko banner)
 *     actually applies `--proxy-server` inside the container.
 *  4. Confirm mounting a Task-6 profile dir under the container's user-data path
 *     makes the persisted profile load (cookies/sessions), and that two different
 *     users' sessions never mount the same directory or share a proxy credential.
 *  5. Confirm the WebSocket client path survives reverse-proxying at
 *     `${APP_BASE_URL}/browser/<sessionId>/` (nginx sessionId -> port mapping).
 * If any of these fail, swap buildNekoArgs() for the Kasm/CDP fallback — only
 * this file needs to change; the rest of the feature is agnostic to it.
 */
