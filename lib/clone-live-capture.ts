// TASK_119A: Live session capture ingest + injection orchestration
// Holds capture payload only for the duration of injection, then deletes it.
// Never persists cookie values to disk — counts only.

import { db } from "./db";
import { injectCookies } from "./cdp";
import type { CdpCookie } from "./cdp";
import { loadCookieJar } from "./clone-cookie-jar";

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
  let cookies: CdpCookie[] | null = payload?.cookies ?? null;
  let capturedAt: string | null = payload?.capturedAt ?? null;
  const truncated = payload?.truncated ?? false;
  // TASK_243 — the durable jar covers a launch whose in-memory payload expired
  // (or a clone started with the PC offline). Same fail-closed rules apply.
  if (!cookies) {
    const job = await db.cloneJob.findUnique({
      where: { id: opts.cloneJobId },
      select: { sourceDeviceId: true, browser: true, profileName: true },
    });
    if (job) {
      const jar = await loadCookieJar({
        deviceId: job.sourceDeviceId,
        browser: job.browser,
        profileName: job.profileName,
      });
      if (jar) {
        cookies = jar.cookies;
        capturedAt = jar.capturedAt;
      }
    }
  }
  if (!cookies) {
    return { ok: false, error: "capture_not_found" };
  }

  try {
    // Fail-closed: reject if capture has 0 cookies (even if truncated=false, it's suspicious).
    if (cookies.length === 0) {
      return { ok: false, error: "empty_capture" };
    }

    // Inject via CDP (proven mechanism from TASK_117).
    const result = await injectCookies({
      port: opts.cdpPort,
      cookies,
      timeoutMs: opts.timeoutMs || 30000,
    });

    if (!result.ok || result.count === 0) {
      // V7: Fixed error message (don't echo CDP error which could contain cookie values).
      return { ok: false, error: "injection_failed" };
    }

    // Record counts on the session (A6: "record cookieCount/domainCount").
    // Non-fatal: the row may not exist yet on the very first launch (the caller
    // upserts it before injecting), and a bookkeeping miss must never tear down
    // a browser whose cookies actually landed.
    const domainCount = new Set(cookies.map((c) => c.domain)).size;
    await db.hostedBrowserSession
      .update({
        where: { cloneJobId: opts.cloneJobId },
        data: {
          sessionMode: "live",
          cookieCount: cookies.length,
          domainCount,
          sessionTruncated: truncated,
          ...(capturedAt ? { capturedAt: new Date(capturedAt) } : {}),
          // TASK_119A A4's acceptance: the port that actually carried the
          // injection is stamped on the session, not just used and forgotten —
          // otherwise nothing on the record proves the endpoint existed, and a
          // later restart (which re-allocates it) has no old value to invalidate.
          cdpPort: opts.cdpPort,
        },
      })
      .catch(() => {});

    // Clear the payload from memory (A5: "delete after use").
    clearCapture(opts.cloneJobId);

    return { ok: true, injectedCount: result.count };
  } catch {
    clearCapture(opts.cloneJobId);
    // V7: Fixed error message (never echo CDP errors that could contain cookie values).
    return { ok: false, error: "injection_failed" };
  }
}
