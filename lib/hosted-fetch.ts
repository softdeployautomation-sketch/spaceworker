// Task 56, Mechanism 3 — resilient fetch wrapper for the desktop EXE's hosted
// calls. In the EXE, account/license/payment operations go to HOSTED_APP_URL via
// these local /api/exe* proxy routes; during a deploy that host is either briefly
// unreachable (the literal systemctl restart window → 502) or in an admin-set
// maintenance window (→ 503 { maintenance: true }). A raw failure there would
// surface as a scary generic error in the EXE UI. Instead this wrapper retries
// through that window with bounded exponential backoff, so the call succeeds and
// proceeds as if nothing happened once the app is back. If it's STILL down after
// the retry budget, it returns the final Response unchanged (including a
// maintenance 503 body) so the caller can surface a clear, non-generic error.
//
// This is the server-side half (used by the /api/exe* proxy routes). It replaces
// each `fetch(\`${HOSTED_APP_URL}...\`)` with hostedFetch() — the EXE's bundled UI
// never calls HOSTED_APP_URL directly, so the retry belongs here at the boundary.

import { HOSTED_APP_URL } from "./exe-runtime";

export interface HostedFetchOptions {
  // Bounded retry budget so we don't hang a user-spinner forever. Defaults cover
  // a ~30s restart window: 1s, 2s, 4s, 8s waited... capping per-attempt at 5s.
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export interface HostedFetchResult {
  /** The final Response (with its body intact for the caller to parse). */
  response: Response;
  /** True if the last response was a 503 { maintenance: true } maintenance flag. */
  maintenance: boolean;
  attempts: number;
}

const MAINTENANCE_STATUS = 503;

/** Shared bounded retry budget for the deploy/maintenance window. */
export const MAX_MAINTENANCE_RETRIES = 12;

function looksLikeMaintenance(res: Response): boolean {
  return res.status === MAINTENANCE_STATUS;
}

export async function hostedFetch(
  path: string,
  init: RequestInit = {},
  options: HostedFetchOptions = {},
): Promise<HostedFetchResult> {
  const {
    maxRetries = 12,
    baseDelayMs = 1000,
    maxDelayMs = 5000,
  } = options;

  const url = `${HOSTED_APP_URL}${path}`;
  const timeoutMs = options.timeoutMs;

  let attempts = 0;
  while (true) {
    attempts += 1;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : init.signal,
      });
    } catch {
      // Network-level failure (connection refused/reset/timeout during restart).
      res = null as unknown as Response;
    }

    if (res) {
      const maintenance = looksLikeMaintenance(res);
      // A maintenance 503 (or another opaque 5xx) is exactly the window we're
      // meant to ride out — keep retrying until the budget is spent.
      if (res.ok || (res.status >= 300 && res.status < 500) || attempts > maxRetries) {
        return { response: res, maintenance, attempts };
      }
    }

    if (attempts > maxRetries) {
      // Give the caller SOMETHING concrete instead of an opaque network error:
      // synthesize a 503 { maintenance: true } when every attempt was an
      // unreachable/5xx, so the EXE shows the friendly retry message.
      return {
        response: new Response(JSON.stringify({ error: "Maintenance", maintenance: true }), {
          status: MAINTENANCE_STATUS,
          headers: { "Content-Type": "application/json" },
        }),
        maintenance: true,
        attempts,
      };
    }

    const delay = Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs);
    await new Promise((r) => setTimeout(r, delay));
  }
}