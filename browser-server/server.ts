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
import { dirname, resolve } from "path";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import httpProxy from "http-proxy";
import { startRelayIngress } from "./relay-ingress";
import {
  buildChromiumSupervisorConf,
  cdpDockerArgs,
  containerProfileDir,
  pinnedDockerArgs,
  type ChromiumSessionOptions,
} from "./chromium-session-config";
import {
  ensurePinnedBrowser,
  versionDirName,
  containerPinnedVersionRoot,
} from "./pinned-chromium";

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
// Clone egress ingress (TASK_118 B8-3). The work PC's relay binds loopback on
// its OWN machine, so our hosted clone browser could never reach it — the old
// "replayed over the Mesh tunnel" note described something never implemented.
// The relay therefore dials OUT to us and this listener serves the browser's
// proxied conns over those outbound connections: no inbound port, no firewall
// rule and no router change on a customer machine.
//
// Started ONLY when a token is configured: an unauthenticated tunnel listener
// would be an open proxy for anything that could dial the port. Bound to the
// public interface by default because the devices are remote.
const RELAY_INGRESS_TOKEN = process.env.RELAY_INGRESS_TOKEN ?? "";
const RELAY_INGRESS_PORT = Number(process.env.RELAY_INGRESS_PORT ?? 3402);
const RELAY_INGRESS_BIND = process.env.RELAY_INGRESS_BIND ?? "0.0.0.0";
// TASK_118 B8-2 — the address a customer device's relay actually DIALS from
// the public internet (distinct from RELAY_INGRESS_BIND, which is where WE
// listen — "0.0.0.0" is not itself a reachable address). This service is the
// only place that knows RELAY_INGRESS_TOKEN at all (the main Next.js app's
// own .env does not have it — kept that way on purpose so the shared ingress
// secret lives in exactly one place); GET /relay/tunnel-config, below, is how
// the main app's relay-install flow learns what a device should dial without
// ever holding the raw secret itself, the same trust boundary every other
// browser-server route already uses (Bearer BROWSER_SERVER_TOKEN).
const RELAY_INGRESS_PUBLIC_HOST = process.env.RELAY_INGRESS_PUBLIC_HOST ?? "164.68.105.96:3402";
// FIXED 2026-09-25 (real click-through test, ERR_PROXY_CONNECTION_FAILED) —
// the address a clone's own container actually reaches THIS host at, for the
// per-device listener (openDeviceListener). Distinct from every other
// RELAY_INGRESS_* constant above, which are about how a customer's DEVICE
// reaches us over the internet: this is host<-container docker networking,
// not device<-internet. "127.0.0.1" (the original, wrong value here) is the
// container's OWN loopback, not the host's — confirmed live via
// `docker network inspect bridge`, the real gateway is 172.17.0.1 on this
// box. Kept env-overridable rather than hardcoded so a differently-configured
// docker network (a custom bridge, a different subnet) doesn't need a code
// change, only a .env one.
const DOCKER_BRIDGE_GATEWAY = process.env.DOCKER_BRIDGE_GATEWAY ?? "172.17.0.1";

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
  /**
   * TASK_119A A4 — a session that must be reachable over CDP (a `live` clone
   * injects its captured cookies this way). Implies: a non-default
   * user-data-dir, DevTools on, the swfwd forwarder running in the container,
   * and a HOST-LOOPBACK port publish (cdpHostPort below).
   */
  cdp: boolean;
  /**
   * TASK_117's blocker list, carried here so it is enforced in one place: a
   * clone session must not be launched browse-without-sign-in, and must name
   * its profile's own password store (the container has no keyring).
   */
  cloneMode: boolean;
  /**
   * TASK_135 §3 — the pinned browser build this session must run, if the caller
   * resolved one. `pinnedRoot` is the host-side cache dir that gets mounted
   * read-only; `pinnedBrowserPath` is what Chromium is executed from inside the
   * container; `pinnedBrowserVersion` is recorded as evidence of what was
   * actually delivered (never as an intention).
   */
  pinnedRoot: string | null;
  pinnedBrowserPath: string | null;
  /** Where the cache dir above is mounted in the container. */
  pinnedContainerRoot: string | null;
  /** The same binary's path on the HOST — checked for existence before launch. */
  pinnedHostBinaryPath: string | null;
  pinnedBrowserVersion: string | null;
  /** True when this launch had to download the build (false = cache hit). */
  pinnedDownloaded: boolean;
  /**
   * TASK_135 §5 — reopen the previous session's tabs. Set by the app once it has
   * actually staged a restored `Sessions/` directory, because the flag on its own
   * does nothing useful and a flag without files would be a lie in the record.
   */
  restoreLastSession: boolean;
  /**
   * TASK_135 §4 — source-device identity, so sites do not see a Linux container
   * where a Windows work PC should be. Validated in chromium-session-config
   * (the values are interpolated into the conf's shell command line).
   */
  userAgent: string | null;
  lang: string | null;
  /** The host-loopback port the container's CDP forwarder is published on. */
  cdpHostPort: number | null;
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
// TASK_118 B8-2 — device-listener close handles, keyed by sessionId, so
// /sessions/stop and /sessions/kill can tear down that session's dedicated
// relay-ingress listener alongside the container. Never left dangling: an
// orphaned listener would keep offering that device's egress after the clone
// it belonged to is gone.
const deviceListenerBySession = new Map<string, { port: number; close: () => void }>();
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

// TASK_119A A4 — where the swfwd forwarder binary lives on the host. Built by
// scripts/engine-dist.mjs (`swfwd-linux-amd64`, a static linux/amd64 binary)
// and rsynced with the other deploy artifacts, so it is versioned and hashed
// alongside the Windows device bundle. Overridable for a different deploy
// layout; a missing binary is a hard launch failure for a CDP session, never a
// silent fallback (see startInternal).
const SWFWD_BIN =
  process.env.SWFWD_BIN ??
  resolve(process.env.CLONE_ENGINE_DIST_DIR ?? "engine-dist", "swfwd-linux-amd64");
// Host-loopback port range for CDP publishes. Must not overlap BASE_PORT
// (Neko's web port) or EPR_BASE (WebRTC's UDP media range) — each of those is
// bound on the host for every session, and a collision would fail the container
// start with a docker port-allocation error.
const CDP_BASE_PORT = Number(process.env.BROWSER_CDP_BASE_PORT ?? 33000);

function allocateCdpHostPort(): number {
  return CDP_BASE_PORT + (portCursor - 1);
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
// Where the per-session chromium.conf lives. MUST NOT sit inside the app dir:
// confirmed live 2026-09-24, a runtime directory under /opt/spaceworker makes
// `next build` fail outright — Turbopack indexes the project root and dies on
// the first file it cannot read ("raw_read_dir failed … Permission denied (os
// error 13)"), and container/Chromium-created files are owner-only (0600) while
// the build runs as the service user (trmm). That is what turned a copy-only
// deploy into a failed build with a stale `.next`.
// Default: a sibling of BROWSER_PROFILE_BASE_DIR (/var/spaceworker/profiles ->
// /var/spaceworker/sessions-tmp), i.e. outside the app root. The cwd-relative
// fallback preserves local dev behaviour when neither env var is set.
const SESSION_TMP_DIR = resolve(
  process.env.BROWSER_SESSIONS_TMP_DIR ??
    (process.env.BROWSER_PROFILE_BASE_DIR
      ? resolve(dirname(process.env.BROWSER_PROFILE_BASE_DIR), "sessions-tmp")
      : "browser-sessions-tmp"),
);

function chromiumConfDir(sessionId: string): string {
  return `${SESSION_TMP_DIR}/${sessionId}`;
}

// The generated conf itself now lives in ./chromium-session-config.ts as a pure
// function with a golden test — so both the flags the existing private-browser
// path has been running since 2026-09-08 AND the CDP/clone additions (non-default
// user-data-dir, DevTools, swfwd, no --bwsi) are asserted rather than trusted.
// The stale-Singleton-lock one-liner described here is generated there, per
// session, from the profile dir that session actually uses.

/**
 * Writes this session's chromium.conf to a scratch dir and returns its host
 * path, or null for a direct (no exit node) session — in which case nothing
 * is mounted and the image's own built-in conf is used unchanged, keeping
 * direct sessions byte-for-byte the same as before this fix.
 */
/** The conf options one session launches with (see Session's own fields). */
function chromiumOptions(session: Session): ChromiumSessionOptions {
  return {
    proxyServerValue: session.proxyServerValue,
    cdp: session.cdp,
    cloneMode: session.cloneMode,
    // TASK_135 §3/§5 — only ever set for a session that resolved a pin and had
    // state staged, so every other session's conf stays byte-identical.
    pinnedBrowserPath: session.pinnedBrowserPath,
    restoreLastSession: session.restoreLastSession,
    // TASK_135 §4 — the identity parity flags. These fields existed on
    // ChromiumSessionOptions from the start but nothing ever populated them, so
    // the flags were unreachable: the conf could emit them and no session ever
    // did. Carried through here so the feature is actually connected.
    userAgent: session.userAgent,
    lang: session.lang,
  };
}

async function prepareChromiumConf(session: Session): Promise<string | null> {
  // A conf is written when the session needs ANY flag the image's own baked-in
  // conf cannot express. That is no longer just the proxy case: a clone session
  // must drop --bwsi and name its password store, and a CDP session must switch
  // user-data-dir and start the forwarder. A direct, non-clone session keeps the
  // image's built-in conf untouched — byte-for-byte as before this change.
  if (!session.proxyServerValue && !session.cdp && !session.cloneMode) return null;
  const dir = chromiumConfDir(session.sessionId);
  await mkdir(dir, { recursive: true });
  const confPath = `${dir}/chromium.conf`;
  await writeFile(confPath, buildChromiumSupervisorConf(chromiumOptions(session)), "utf8");
  return confPath;
}

async function cleanupChromiumConf(sessionId: string): Promise<void> {
  await rm(chromiumConfDir(sessionId), { recursive: true, force: true }).catch(() => {});
}

/** Docker/Neko launch — THE spike surface. Built as an arg array, never shell-joined. */
function buildNekoArgs(session: Session, chromiumConfPath: string | null): string[] {
  const password = randomBytes(9).toString("base64url");
  session.nekoPassword = password; // stored so the frontend can auto-login — see Session.nekoPassword
  const profileMount = `${session.profileDir}:${containerProfileDir(chromiumOptions(session))}`;
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
  // TASK_119A A4 — the CDP endpoint, when this session needs one: the forwarder
  // binary (read-only) plus its HOST-LOOPBACK port publish. Throws on an
  // unallocated port or an unconfigured binary path, so a `live` clone can never
  // start without the endpoint its cookie injection depends on.
  args.push(
    ...cdpDockerArgs({
      cdp: session.cdp,
      cdpHostPort: session.cdpHostPort,
      swfwdPath: SWFWD_BIN,
    }),
  );
  // TASK_135 §3 — the pinned build, read-only. Fail closed on an inconsistent
  // session rather than starting a clone on the image's own Chromium while the
  // conf says otherwise: that mismatch would half-load a profile.
  if (session.pinnedBrowserPath) {
    if (!session.pinnedRoot || !session.pinnedContainerRoot) {
      throw new Error("pinned_browser_mount_unconfigured");
    }
    args.push(
      ...pinnedDockerArgs({
        pinnedRoot: session.pinnedRoot,
        containerVersionRoot: session.pinnedContainerRoot,
      }),
    );
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

/**
 * TASK_135 §3 — the pinned-build request from a caller, validated BEFORE any
 * work happens. Shape errors are 400s: the request is built by our own app, so a
 * malformed one is a programming error rather than a runtime condition, and it
 * must not get as far as a download.
 */
function parsePinnedRequest(value: unknown): {
  request: { fullVersion: string; downloadUrl: string } | null;
  problem?: string;
} {
  if (value === undefined || value === null) return { request: null };
  if (typeof value !== "object") {
    return { request: null, problem: "pinnedBrowser must be an object" };
  }
  const raw = value as { fullVersion?: unknown; downloadUrl?: unknown };
  const fullVersion = typeof raw.fullVersion === "string" ? raw.fullVersion.trim() : "";
  const downloadUrl = typeof raw.downloadUrl === "string" ? raw.downloadUrl.trim() : "";
  if (!versionDirName(fullVersion)) {
    return { request: null, problem: "pinnedBrowser.fullVersion is not a version" };
  }
  if (!/^https?:\/\//.test(downloadUrl)) {
    return { request: null, problem: "pinnedBrowser.downloadUrl must be http(s)" };
  }
  return { request: { fullVersion, downloadUrl } };
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
  if (session.cdp) {
    // Fail FAST, before any container exists: a live clone whose forwarder is
    // not on disk would otherwise come up as a browser nothing can reach, and
    // the failure would surface later as an unexplained injection error.
    const present = await stat(SWFWD_BIN).then(() => true).catch(() => false);
    if (!present) {
      throw new Error(`swfwd_binary_missing: ${SWFWD_BIN}`);
    }
    session.cdpHostPort = allocateCdpHostPort();
  }
  if (session.pinnedBrowserPath) {
    // Same fail-fast reasoning as the forwarder above: a pinned session whose
    // binary is not on disk would come up on nothing at all (the conf execs a
    // path that does not exist), and the error would surface much later as an
    // unexplained dead session.
    const present = await stat(session.pinnedHostBinaryPath ?? "")
      .then((info) => info.isFile())
      .catch(() => false);
    if (!present) {
      throw new Error(`pinned_browser_binary_missing: ${session.pinnedHostBinaryPath}`);
    }
  }
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
  // TASK_118 B8-2 — close this session's dedicated device listener (if any)
  // unconditionally, before either branch below: an orphaned listener must
  // never survive its clone, whether the stop is graceful or the entry was
  // already lost (e.g. a prior service restart).
  const listener = deviceListenerBySession.get(sessionId);
  if (listener) {
    listener.close();
    deviceListenerBySession.delete(sessionId);
  }
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
    // Host-loopback only, and only ever set for a session that asked for CDP —
    // reported for observability (an admin can see which port to probe), never
    // as something a caller may treat as reachable from outside the host.
    cdpPort: s.cdpHostPort,
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

// Clone egress ingress (TASK_118 B8-3) — see the RELAY_INGRESS_* comment above.
// Null when unconfigured, so this subsystem keeps working without it.
const egressIngress = RELAY_INGRESS_TOKEN
  ? startRelayIngress({
      bind: RELAY_INGRESS_BIND,
      port: RELAY_INGRESS_PORT,
      token: RELAY_INGRESS_TOKEN,
      log: (msg) => {
        console.log(msg); // subsystem logging convention (tsx service, journald)
      },
    })
  : null;

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
  // Clone egress routing (TASK_118 B8-3). Registered by the clone launcher —
  // the only code that knows which device a session egresses through. Handled
  // BEFORE the generic POST branch below, which requires a sessionId.
  if (req.method === "GET" && url === "/relay/stats") {
    json(res, 200, egressIngress ? egressIngress.stats() : { controls: 0, routes: 0, streams: 0, disabled: true });
    return;
  }
  // TASK_118 B8-2 — what a device's relay-install flow needs to dial. The main
  // app never holds RELAY_INGRESS_TOKEN itself (see the const's own comment) —
  // this is the one sanctioned way it learns it, over the SAME Bearer trust
  // boundary every other route here already uses.
  if (req.method === "GET" && url.startsWith("/relay/control-status")) {
    const deviceKey = new URL(req.url ?? "/", "http://internal").searchParams.get("deviceKey") ?? "";
    if (!deviceKey) {
      json(res, 400, { error: "deviceKey query param is required" });
      return;
    }
    json(res, 200, { up: egressIngress ? egressIngress.hasControl(deviceKey) : false });
    return;
  }
  if (req.method === "GET" && url === "/relay/tunnel-config") {
    if (!egressIngress) {
      json(res, 503, { error: "relay ingress disabled (RELAY_INGRESS_TOKEN unset)" });
      return;
    }
    json(res, 200, { tunnelHost: RELAY_INGRESS_PUBLIC_HOST, token: RELAY_INGRESS_TOKEN });
    return;
  }
  // A dedicated, unauthenticated, loopback-only proxy port for exactly one
  // device — see relay-ingress.ts's openDeviceListener doc comment for why
  // this exists (Chrome cannot present the shared port's credential for a
  // fresh, one-shot clone profile). sessionId scopes the listener's lifetime
  // to one launch so /sessions/stop can find and close it.
  if (req.method === "POST" && url === "/relay/device-listener") {
    if (!egressIngress) {
      json(res, 503, { error: "relay ingress disabled (RELAY_INGRESS_TOKEN unset)" });
      return;
    }
    const dlBody = await readBody(req);
    const deviceKey = String(dlBody.deviceKey ?? "");
    const sessionId = String(dlBody.sessionId ?? "");
    if (!deviceKey || !/^[a-z0-9]+$/i.test(sessionId)) {
      json(res, 400, { error: "deviceKey and a valid sessionId are required" });
      return;
    }
    const existing = deviceListenerBySession.get(sessionId);
    if (existing) {
      // Idempotent: a retried launch reuses the same port instead of leaking one.
      json(res, 200, { ok: true, port: existing.port, host: DOCKER_BRIDGE_GATEWAY });
      return;
    }
    try {
      const handle = await egressIngress.openDeviceListener(deviceKey);
      deviceListenerBySession.set(sessionId, handle);
      // `host` is what the CONTAINER should dial (the docker bridge
      // gateway), never 127.0.0.1 — see DOCKER_BRIDGE_GATEWAY's own comment.
      json(res, 200, { ok: true, port: handle.port, host: DOCKER_BRIDGE_GATEWAY });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : "device listener failed to start" });
    }
    return;
  }
  if (req.method === "POST" && (url === "/relay/route" || url === "/relay/route/remove")) {
    if (!egressIngress) {
      json(res, 503, { error: "relay ingress disabled (RELAY_INGRESS_TOKEN unset)" });
      return;
    }
    const relayBody = await readBody(req);
    const routingSecret = String(relayBody.routingSecret ?? "");
    // Generated server-side per job; the shape check keeps a malformed or
    // guessed value from ever becoming a routing key.
    if (!/^[a-f0-9]{32,128}$/i.test(routingSecret)) {
      json(res, 400, { error: "Invalid routingSecret" });
      return;
    }
    if (url === "/relay/route/remove") {
      egressIngress.removeRoute(routingSecret);
      json(res, 200, { ok: true, ...egressIngress.stats() });
      return;
    }
    const deviceKey = String(relayBody.deviceKey ?? "");
    if (!deviceKey) {
      json(res, 400, { error: "Invalid deviceKey" });
      return;
    }
    const ttlMs = Number(relayBody.ttlMs ?? 0);
    egressIngress.addRoute(routingSecret, deviceKey, ttlMs > 0 ? ttlMs : undefined);
    json(res, 200, { ok: true, ...egressIngress.stats() });
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
      // TASK_135 §3 — install (or find) the pinned build WITHOUT starting a
      // session. This is what lets the app materialise a restored profile only
      // once the build is guaranteed to exist: download first, write the files
      // second, launch third. The other order would leave files staged for a
      // browser the launch then failed to deliver, and the documented fallback
      // would open them with the WRONG build — the corruption the pin exists to
      // prevent.
      if (url === "/pinned/ensure") {
        const pin = parsePinnedRequest(body.pinnedBrowser);
        if (pin.problem || !pin.request) {
          json(res, 400, { error: pin.problem ?? "pinnedBrowser is required" });
          return;
        }
        const installed = await ensurePinnedBrowser(pin.request);
        if (!installed.ok) {
          json(res, 409, { error: installed.error });
          return;
        }
        json(res, 200, {
          ok: true,
          fullVersion: pin.request.fullVersion,
          hostRoot: installed.hostRoot,
          containerBinaryPath: installed.containerBinaryPath,
          downloaded: installed.downloaded,
        });
        return;
      }
      if (url === "/sessions/start") {
        const userId = String(body.userId ?? "");
        const profileDir = String(body.profileDir ?? "");
        // Empty proxyServerValue is valid — direct connection, no exit node.
        const proxyServerValue = String(body.proxyServerValue ?? "");
        // TASK_119A A4 — opted into by the clone launcher only. `cdp` implies a
        // non-default user-data-dir, DevTools, the in-container forwarder and a
        // host-loopback publish; `cloneMode` drops --bwsi and names the
        // container's password store. Both default OFF, so every existing caller
        // (and the private browser) keeps today's behaviour exactly.
        const cdp = body.cdp === true;
        const cloneMode = body.cloneMode === true;
        const restoreLastSession = body.restoreLastSession === true;
        // TASK_135 §4 — identity parity. Optional; absent means no flags at all,
        // which is what keeps every non-clone session's conf unchanged. Length
        // is capped before validation so an absurd value cannot reach the conf
        // builder at all.
        const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 512).trim() : "";
        const lang = typeof body.lang === "string" ? body.lang.slice(0, 64).trim() : "";
        if (!userId || !profileDir) {
          json(res, 400, { error: "userId and profileDir are required" });
          return;
        }
        // TASK_135 §3 — the pinned build, installed (or found in the cache)
        // BEFORE a container exists. A version that cannot be delivered is a 409
        // naming the reason, with no container to clean up and no session on the
        // wrong browser. The fallback decision is deliberately NOT taken here:
        // lib/clone-hosted-launch.ts owns the job record and retries explicitly
        // without the pin, so the outcome is recorded rather than silent.
        let pinnedRoot: string | null = null;
        let pinnedBrowserPath: string | null = null;
        let pinnedContainerRoot: string | null = null;
        let pinnedHostBinaryPath: string | null = null;
        let pinnedBrowserVersion: string | null = null;
        let pinnedDownloaded = false;
        const pin = parsePinnedRequest(body.pinnedBrowser);
        if (pin.problem) {
          json(res, 400, { error: pin.problem });
          return;
        }
        if (pin.request) {
          const installed = await ensurePinnedBrowser(pin.request);
          if (!installed.ok) {
            json(res, 409, { error: `pinned_browser_unavailable: ${installed.error}` });
            return;
          }
          pinnedRoot = installed.hostRoot;
          pinnedBrowserPath = installed.containerBinaryPath;
          // Derived from the SAME version name as the binary path above, via the
          // pin module, so the mount destination and the exec'd path can never
          // describe different places (the 2026-09-28 bug).
          pinnedContainerRoot = containerPinnedVersionRoot(versionDirName(pin.request.fullVersion) ?? "");
          pinnedHostBinaryPath = installed.hostBinaryPath;
          pinnedBrowserVersion = pin.request.fullVersion;
          pinnedDownloaded = installed.downloaded;
        }
        const session: Session = {
          sessionId,
          userId,
          profileDir: resolve(profileDir),
          proxyServerValue,
          cdp,
          cloneMode,
          pinnedRoot,
          pinnedBrowserPath,
          pinnedContainerRoot,
          pinnedHostBinaryPath,
          pinnedBrowserVersion,
          pinnedDownloaded,
          restoreLastSession,
          userAgent: userAgent || null,
          lang: lang || null,
          cdpHostPort: null,
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
          // TASK_119A A4 — the host-loopback port the clone's CDP endpoint is
          // published on, for lib/clone-hosted-launch.ts to inject through.
          // null for every session that did not ask for CDP.
          cdpPort: finalSession?.cdpHostPort ?? null,
          // TASK_135 §3 — what was ACTUALLY delivered, so the app can stamp
          // evidence on the job instead of echoing its own intent back at itself.
          pinnedBrowserVersion: finalSession?.pinnedBrowserVersion ?? null,
          pinnedDownloaded: finalSession?.pinnedDownloaded ?? false,
          restoreLastSession: finalSession?.restoreLastSession ?? false,
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
        json(res, 200, {
          ok: true,
          port: registry.get(sessionId)?.port ?? null,
          // A restart re-allocates the CDP port (startInternal). Returning it
          // keeps a caller that holds the old value from injecting into a port
          // that is now someone else's session (or nothing at all).
          cdpPort: registry.get(sessionId)?.cdpHostPort ?? null,
        });
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
  await egressIngress?.close().catch(() => {});
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
