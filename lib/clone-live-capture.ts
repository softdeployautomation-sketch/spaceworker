// TASK_119A: Live session capture ingest + injection orchestration
// Holds capture payload only for the duration of injection, then deletes it.
// Never persists cookie values to disk — counts only.

import { db } from "./db";
import { injectCookies } from "./cdp";
import type { CdpCookie } from "./cdp";

export interface LiveCapturePayload {
  cloneJobId: string;
  deviceId: string;
  browser: string;
  capturedAt: string;
  cookies: CdpCookie[];
  truncated: boolean;
}

/**
 * Store a live capture payload temporarily (in-memory, 0600 file if persisted).
 * Used during the launch window only — deleted after injection or on failure.
 * TASK_119A A5: "never logged, echoed, audited beyond its short TTL"
 */
const payloadStore = new Map<string, { payload: LiveCapturePayload; expiresAt: Date }>();

const PAYLOAD_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function storeCapture(payload: LiveCapturePayload): void {
  const expiresAt = new Date(Date.now() + PAYLOAD_TTL_MS);
  payloadStore.set(payload.cloneJobId, { payload, expiresAt });
  // Auto-expire after TTL
  setTimeout(() => {
    payloadStore.delete(payload.cloneJobId);
  }, PAYLOAD_TTL_MS);
}

export function getCapture(cloneJobId: string): LiveCapturePayload | null {
  const entry = payloadStore.get(cloneJobId);
  if (!entry) return null;
  if (new Date() > entry.expiresAt) {
    payloadStore.delete(cloneJobId);
    return null;
  }
  return entry.payload;
}

export function clearCapture(cloneJobId: string): void {
  payloadStore.delete(cloneJobId);
}

/**
 * Inject captured cookies into a hosted clone session via CDP.
 * Called from lib/clone-hosted-launch.ts after container starts.
 * A6: "If the capture yields 0 cookies, or injection cannot be verified,
 *      the launch REFUSES with a named reason — never a silent fallback to fresh."
 */
export async function injectLiveCapture(opts: {
  cloneJobId: string;
  cdpPort: number;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  error?: string;
  injectedCount?: number;
}> {
  const payload = getCapture(opts.cloneJobId);
  if (!payload) {
    return { ok: false, error: "capture_not_found" };
  }

  try {
    // Fail-closed: reject if capture has 0 cookies (even if truncated=false, it's suspicious).
    if (payload.cookies.length === 0) {
      return { ok: false, error: "empty_capture" };
    }

    // Inject via CDP (proven mechanism from TASK_117).
    const result = await injectCookies({
      port: opts.cdpPort,
      cookies: payload.cookies,
      timeoutMs: opts.timeoutMs || 30000,
    });

    if (!result.ok || result.count === 0) {
      // V7: Fixed error message (don't echo CDP error which could contain cookie values).
      return { ok: false, error: "injection_failed" };
    }

    // Record counts on the session (A6: "record cookieCount/domainCount").
    const domainCount = new Set(payload.cookies.map((c) => c.domain)).size;
    await db.hostedBrowserSession.update({
      where: { cloneJobId: opts.cloneJobId },
      data: {
        sessionMode: "live",
        cookieCount: payload.cookies.length,
        domainCount,
        sessionTruncated: payload.truncated,
        capturedAt: new Date(payload.capturedAt),
      },
    });

    // Clear the payload from memory (A5: "delete after use").
    clearCapture(opts.cloneJobId);

    return { ok: true, injectedCount: result.count };
  } catch (err) {
    clearCapture(opts.cloneJobId);
    // V7: Fixed error message (never echo CDP errors that could contain cookie values).
    return { ok: false, error: "injection_failed" };
  }
}
