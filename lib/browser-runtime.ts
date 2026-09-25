import "server-only";

/**
 * Thin localhost client for the standalone browser subsystem
 * (`spaceworker-browser.service`, see browser-server/server.ts). The interactive
 * Chrome/Neko processes NEVER run inside the Next.js process — PLAN.md §197 hard
 * requirement — so the app talks to the subsystem over HTTPS-free localhost with
 * the BROWSER_SERVER_TOKEN bearer secret. If the subsystem isn't running (e.g.
 * local dev), every call degrades to a clear "runtime unavailable" error.
 */

const BASE_URL = process.env.BROWSER_SERVER_URL ?? "http://127.0.0.1:3401";
const TOKEN = process.env.BROWSER_SERVER_TOKEN ?? "";

export interface RuntimeSession {
  sessionId: string;
  userId: string;
  pid: number | null;
  containerName: string | null;
  port: number | null;
  status: string;
  nekoPassword: string | null;
}

export type RuntimeResult =
  | { ok: true; data?: unknown; error?: undefined }
  | { ok: false; error: string };

export function browserRuntimeAvailable(): boolean {
  return TOKEN.trim().length > 0;
}

async function call(path: string, body?: unknown): Promise<RuntimeResult> {
  if (!TOKEN.trim()) {
    return { ok: false, error: "Browser runtime not configured (BROWSER_SERVER_TOKEN unset)" };
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Subsystem launch can be slow (docker pull first time) — be generous.
      signal: AbortSignal.timeout(120_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, error: String(data.error ?? `Runtime error ${res.status}`) };
    }
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: `Browser runtime unreachable: ${e instanceof Error ? e.message : "unknown"}`,
    };
  }
}

export const browserRuntime = {
  start(input: {
    sessionId: string;
    userId: string;
    profileDir: string;
    proxyServerValue: string;
  }): Promise<RuntimeResult> {
    return call("/sessions/start", input);
  },
  /**
   * TASK_118 B8-2 — what a device's relay-install flow should dial, without
   * ever exposing the raw ingress secret to this app's own .env (see
   * RELAY_INGRESS_PUBLIC_HOST's comment in browser-server/server.ts).
   */
  relayTunnelConfig(): Promise<RuntimeResult> {
    return call("/relay/tunnel-config");
  },
  /**
   * TASK_118 B8-2 — opens the dedicated, unauthenticated local proxy port a
   * hosted clone's Chromium points --proxy-server at (relay-ingress.ts's
   * openDeviceListener). Idempotent per sessionId.
   */
  openRelayDeviceListener(input: { deviceKey: string; sessionId: string }): Promise<RuntimeResult> {
    return call("/relay/device-listener", input);
  },
  /** TASK_118 B8-2 — the fail-closed pre-check (see hasControl's own comment). */
  relayControlStatus(deviceKey: string): Promise<RuntimeResult> {
    return call(`/relay/control-status?deviceKey=${encodeURIComponent(deviceKey)}`);
  },
  stop(sessionId: string): Promise<RuntimeResult> {
    return call("/sessions/stop", { sessionId });
  },
  restart(input: {
    sessionId: string;
    profileDir: string;
    proxyServerValue: string;
  }): Promise<RuntimeResult> {
    return call("/sessions/restart", input);
  },
  kill(sessionId: string): Promise<RuntimeResult> {
    return call("/sessions/kill", { sessionId });
  },
  list(): Promise<RuntimeResult> {
    return call("/sessions");
  },
};