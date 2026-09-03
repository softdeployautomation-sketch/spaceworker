import "server-only";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3400";

/**
 * The public connect URL the dashboard panel iframes. Deploy-side (nginx/VPS)
 * reverse-proxies `${APP_BASE_URL}/browser/<sessionId>/` — WebSocket upgrade
 * included — to the session's Neko container port (see browser-server/README.md).
 */
export function connectUrlFor(sessionId: string): string {
  return `${APP_BASE_URL}/browser/${sessionId}/`;
}

export interface SessionViewInput {
  id: string;
  status: string;
  proxyMode: string;
  exitNodeId: string | null;
  byoProxyHost: string | null;
  byoProxyPort: number | null;
  byoProxyScheme: string | null;
  byoProxyUsername: string | null;
  containerId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

/** Shape every browser-session response shares (no credentials ever exposed). */
export function serializeSession(s: SessionViewInput) {
  return {
    id: s.id,
    status: s.status,
    proxyMode: s.proxyMode,
    exitNodeId: s.exitNodeId,
    byoProxyHost: s.byoProxyHost,
    byoProxyPort: s.byoProxyPort,
    byoProxyScheme: s.byoProxyScheme,
    byoProxyUsername: s.byoProxyUsername,
    containerId: s.containerId,
    startedAt: s.startedAt?.toISOString() ?? null,
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    connectUrl: s.status === "running" ? connectUrlFor(s.id) : null,
  };
}