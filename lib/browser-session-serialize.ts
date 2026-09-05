import "server-only";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3400";

/**
 * The public connect URL the dashboard panel iframes. Deploy-side (nginx/VPS)
 * reverse-proxies `${APP_BASE_URL}/browser/<sessionId>/` — WebSocket upgrade
 * included — to the session's Neko container port (see browser-server/README.md).
 *
 * Neko's own login screen would otherwise appear on every connect since each
 * session gets a fresh random NEKO_PASSWORD — Neko supports `?usr=&pwd=` auto-
 * login query params, so the password is embedded here (server-side only) rather
 * than shipped to the client as its own field. `embed=1` hides Neko's UI chrome
 * since this is iframed, not used as a standalone app.
 */
export function connectUrlFor(sessionId: string, nekoPassword: string | null): string {
  const base = `${APP_BASE_URL}/browser/${sessionId}/`;
  if (!nekoPassword) return base;
  const params = new URLSearchParams({ usr: "Session", pwd: nekoPassword, embed: "1" });
  return `${base}?${params.toString()}`;
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
  nekoPassword: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
}

/** Shape every browser-session response shares (no bare credential field ever exposed). */
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
    connectUrl: s.status === "running" ? connectUrlFor(s.id, s.nekoPassword) : null,
  };
}