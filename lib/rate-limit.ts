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
  | "exe-password-login";

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