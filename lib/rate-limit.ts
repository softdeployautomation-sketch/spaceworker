import "server-only";

import { headers } from "next/headers";

import { db } from "./db";

// IP-based rate limiting via the RateLimitEvent table. Fine at single-instance
// scale (per plan); move to Redis if SpaceWorker ever runs multiple instances.

export type RateLimitKind =
  | "signup"
  | "login"
  | "resend-code"
  | "verify"
  | "admin-login"
  | "change-password"
  | "exe-password-login"
  | "exe-auto-bind"
  | "exe-license-eligibility"
  | "mailbox-test"
  | "billing-submit"
  | "trial-ping"
  | "wallet-read"
  | "wallet-spend"
  | "overview-stats"
  | "vantra-link";

interface Rule {
  /** Number of events allowed within the window. */
  limit: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
}

/**
 * Guardrail limits (matching Vantra's proven defaults):
 *  - signup:      5/hr
 *  - login:      10/hr
 *  - resend-code: 1/60s AND 5/hr (both enforced)
 *  - verify:     10 attempts cap (short window is effectively a cap via limit)
 *  - admin-login: same posture as the customer login
 */
const RULES: Record<RateLimitKind, Rule[]> = {
  signup: [{ limit: 5, windowMs: 60 * 60 * 1000 }],
  login: [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  "resend-code": [
    { limit: 1, windowMs: 60 * 1000 },
    { limit: 5, windowMs: 60 * 60 * 1000 },
  ],
  verify: [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  "admin-login": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  "change-password": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  "exe-password-login": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  "exe-auto-bind": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  // Fixed 2026-09-21 — the live revocation check every status poll makes.
  // Generous: legitimately called on every app launch (and future periodic
  // polls), possibly by several devices behind the same NAT/IP.
  "exe-license-eligibility": [{ limit: 120, windowMs: 60 * 60 * 1000 }],
  // Task 51 — "Test connection" does a raw outbound SMTP attempt per call, so
  // cap the rate (session-gated already; this is IP-scoped like the other routes).
  "mailbox-test": [{ limit: 20, windowMs: 60 * 60 * 1000 }],
  // Task 52 — the no-session EXE buy path of billing/submit creates User +
  // Payment rows on demand; cap it so a script can't flood the admin review queue.
  "billing-submit": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  // Task 52 — trial-ping is intentionally unauthenticated (the EXE has no web
  // session) and feeds the admin's active-trial-devices view; a modest per-IP cap
  // covers the one-ping-per-device-per-session real pattern while blocking spam.
  "trial-ping": [{ limit: 20, windowMs: 60 * 60 * 1000 }],
  // Task 158 W2 — GET /api/wallet. The dashboard balance card polls this, so the
  // cap has to clear a real client refreshing on a timer. Generous for that
  // reason, and the same reasoning as exe-license-eligibility: several devices
  // behind one NAT share an IP. It exists to stop an unbounded read of the
  // balance, not to police a user clicking refresh.
  "wallet-read": [{ limit: 120, windowMs: 60 * 60 * 1000 }],
  // PLAN_TASK_158 W5 — POST /api/wallet/spend moves money, so it gets the
  // billing-submit posture (10/hr), NOT the wallet-read polling budget. The
  // UI fires one POST per button click; 10/hr covers double-clicks + keyed
  // retries while stopping a script from hammering a spend.
  "wallet-spend": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
  // PLAN_TASK_165 P3 — GET /api/overview-stats, the status row under the welcome
  // panel. Same shape of traffic as wallet-read (it backs a dashboard that loads
  // once per visit, plus a manual Refresh button) and for the same reason: the
  // cap exists to stop an unbounded scrape of a user's own numbers, not to police
  // someone opening their own dashboard.
  "overview-stats": [{ limit: 120, windowMs: 60 * 60 * 1000 }],
  // TASK_181 P2 — POST /api/assistant/vantra (org provisioning) is now OPEN to
  // free users, so it became a new abuse surface: each attempt can mint an
  // org + Vantra-side rows. One user gets ONE org (idempotent upsert), so the
  // real pattern is a handful of clicks; 10/hr mirrors wallet-spend's
  // double-click posture while stopping a script from hammering provisioning.
  "vantra-link": [{ limit: 10, windowMs: 60 * 60 * 1000 }],
};

export async function getClientIp(): Promise<string> {
  const h = await headers();
  // Trust the first proxy-provided X-Forwarded-For entry (nginx sets it).
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip") ?? "unknown";
}

async function countInWindow(ip: string, kind: RateLimitKind, windowMs: number) {
  const since = new Date(Date.now() - windowMs);
  return db.rateLimitEvent.count({
    where: {
      ip,
      kind,
      createdAt: { gte: since },
    },
  });
}

/**
 * Records one event and returns true if the caller is still allowed.
 * Call BEFORE performing the action, then record the result after the action.
 * (Recording first prevents bypassing the cap by never hitting the action.)
 */
export async function allowAndRecord(ip: string, kind: RateLimitKind): Promise<boolean> {
  const rules = RULES[kind];
  for (const rule of rules) {
    const count = await countInWindow(ip, kind, rule.windowMs);
    if (count >= rule.limit) {
      return false;
    }
  }
  await db.rateLimitEvent.create({ data: { ip, kind } });
  return true;
}

/** Returns the remaining attempts available for the kind (for client messaging). */
export async function remainingAttempts(
  ip: string,
  kind: RateLimitKind,
): Promise<number> {
  const rules = RULES[kind];
  const seen: Record<number, number> = {};
  let min = Infinity;
  for (const rule of rules) {
    const key = rule.windowMs;
    if (seen[key] !== undefined) {
      min = Math.min(min, seen[key]);
      continue;
    }
    const count = await countInWindow(ip, kind, rule.windowMs);
    const rem = rule.limit - count;
    seen[key] = rem;
    min = Math.min(min, rem);
  }
  return Math.max(0, min);
}