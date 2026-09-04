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
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { resolve } from "path";

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
const EPR = process.env.BROWSER_NEKO_EPR ?? "52000-52100";
const BASE_PORT = Number(process.env.BROWSER_SESSION_BASE_PORT ?? 32000);

interface Session {
  sessionId: string;
  userId: string;
  profileDir: string;
  proxyServerValue: string;
  pid: number | null;
  containerName: string | null;
  port: number | null;
  status: string; // "starting" | "running" | "stopped"
  startedAt: number;
}

const registry = new Map<string, Session>();
let portCursor = 0;

function allocatePort(): number {
  return BASE_PORT + portCursor++;
}

function containerName(sessionId: string): string {
  return `spaceworker-browser-${sessionId}`;
}

/** Docker/Neko launch — THE spike surface. Built as an arg array, never shell-joined. */
function buildNekoArgs(session: Session): string[] {
  const password = randomBytes(9).toString("base64url");
  const profileMount = `${session.profileDir}:/home/neko/.config/chromium`;
  // Neko passes browser args through its Chromium wrapper. The exact env name is
  // a spike-verification item on the VPS (older banners used NEKO_BROWSER_ARGS).
  const browserArgs = `--proxy-server=${session.proxyServerValue} --user-data-dir=/home/neko/.config/chromium`;
  const args: string[] = [
    "run",
    "-d",
    "--rm",
    "--name", session.containerName!,
    "-p", `${session.port}:8080`,
    "-v", profileMount,
    "-e", `NEKO_PASSWORD=${password}`,
    "-e", `NEKO_PASSWORD_ADMIN=${password}`,
    "-e", `NEKO_PROXY=default`,
    "-e", `NEKO_SCREEN=1280x720@30`,
    "-e", `NEKO_EPR=${EPR}`,
    "-e", `NEKO_BROWSER_ARGS=${browserArgs}`,
  ];
  if (HOST_PUBLIC_IP) {
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

async function startInternal(session: Session): Promise<string> {
  const entry = registry.get(session.sessionId);
  if (entry && entry.status === "running") {
    return entry.containerName ?? ""; // idempotent
  }
  session.pid = process.pid; // registry owner; real work lives in the docker container
  session.containerName = containerName(session.sessionId);
  session.port = allocatePort();
  session.status = "starting";
  registry.set(session.sessionId, session);

  try {
    const id = await docker(...buildNekoArgs(session));
    if (!id) {
      throw new Error("docker did not return a container id");
    }
    if (!(await waitRunning(session.containerName))) {
      throw new Error("container never reached running state");
    }
    session.status = "running";
    registry.set(session.sessionId, session);
    return id;
  } catch (e) {
    // best-effort cleanup so we never leave an orphaned container behind
    await docker("rm", "-f", session.containerName).catch(() => {});
    session.status = "stopped";
    session.containerName = null;
    registry.set(session.sessionId, session);
    throw e;
  }
}

async function stopInternal(sessionId: string, force: boolean): Promise<void> {
  const entry = registry.get(sessionId);
  if (!entry) {
    // unknown locally — clean anything we may have half-launched
    await docker("rm", "-f", containerName(sessionId)).catch(() => {});
    return;
  }
  if (entry.containerName) {
    await docker("rm", "-f", entry.containerName).catch(() => {});
  }
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
  };
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
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
        const proxyServerValue = String(body.proxyServerValue ?? "");
        if (!userId || !profileDir || !proxyServerValue) {
          json(res, 400, { error: "userId, profileDir and proxyServerValue are required" });
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
          status: "starting",
          startedAt: Date.now(),
        };
        const container = await startInternal(session);
        const finalSession = registry.get(sessionId);
        json(res, 200, {
          ok: true,
          containerName: finalSession?.containerName ?? null,
          port: finalSession?.port ?? null,
          containerId: container,
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

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`browser subsystem listening on ${HOST}:${PORT}`);
});
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
