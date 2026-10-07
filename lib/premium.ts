import "server-only";

import type { Prisma } from "@prisma/client";

import { db } from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;
// Matches Vantra's PREMIUM_DAYS_PER_CHARGE — one charge = 30 days of premium,
// and admin grant/extend uses the same constant so the two are indistinguishable.
export const PREMIUM_DAYS_PER_CHARGE = 30;

/**
 * Task 55 — SpaceWorker time-limited premium (per-User, unlike Vantra which is
 * per-Organization).
 *
 * Tier semantics (see prisma User.tier comment): 5 = Premium, 1 = free trial,
 * 0 = legacy/license_only. Premium is now time-limited via User.premiumExpiresAt
 * with these NULLABLE rules:
 *   - NULL on a tier:5 user = GRANDFATHERED (created before this field landed) —
 *     never expires, never backfill. The reversion check (premiumExpiresAt ===
 *     null) deliberately leaves them untouched.
 *   - NULL on tier < 5 = "not premium" (meaningless free row).
 *   - non-NULL = a real paid term. Once it passes, the lazy check-on-read in
 *     applyPremiumReversion() flips tier back to 1 so the existing `>= 5` gates
 *     (browser-profiles, browser-sessions, trial.ts, dispatch, etc.) revoke
 *     access automatically on the next fresh read — no extra instrumentation.
 */
export const PREMIUM_TIER = 5;
// TASK_181 P2 — tier 3 = the XDevice subscription (the wrapper's "Subscribe to
// Premium", admin-priced): a TIME-LIMITED, devices-only tier. NOT premium —
// every `>= 5` gate stays correctly closed for it — and it never catch-alls:
// hasEntitlement lights exactly the "devices" key while its term is live.
export const XDEVICE_TIER = 3;

/**
 * Given a freshly-loaded User row (with at least { tier, premiumExpiresAt }),
 * returns true if the user currently holds premium. Applies the lazy reversion:
 * a tier-5 user whose premiumExpiresAt is a non-null date in the PAST is
 * downgraded back to tier 1 (persisted) and reported as not premium.
 *
 * Expects `user` to already include `premiumExpiresAt`. If the caller grabbed
 * only `{ tier }` it must add the expiry column — see applyPremiumReversion below.
 */
export function isPremiumWithReversion(user: {
  tier: number;
  premiumExpiresAt: Date | null;
}): boolean {
  if (user.tier < PREMIUM_TIER) return false;
  // Grandfathered / never-expiring.
  if (user.premiumExpiresAt === null) return true;
  if (user.premiumExpiresAt.getTime() > Date.now()) return true;
  // Expired — handled lazily by the caller to persist the downgrade once.
  return false;
}

/**
 * Persists the lazy downgrade for an expired premium account (tier 5 with a
 * passed premiumExpiresAt). NO-OP for non-expired / grandfathered users, so it's
 * safe to call on every read. Returns the id if a reversion actually happened.
 */
export async function applyPremiumReversion(userId: string, tier: number, premiumExpiresAt: Date | null): Promise<boolean> {
  // TASK_181 — tier 3 (XDEVICE_TIER) is time-limited by the SAME
  // premiumExpiresAt column and reverts by the same check-on-read; tiers
  // 0/1/4 never carry a term, exactly as before.
  if (tier < PREMIUM_TIER && tier !== XDEVICE_TIER) return false;
  if (premiumExpiresAt === null) return false; // grandfathered — never downgrade
  if (premiumExpiresAt.getTime() > Date.now()) return false;
  await db.user.updateMany({
    where: {
      id: userId,
      tier: { in: [PREMIUM_TIER, XDEVICE_TIER] },
      premiumExpiresAt: { not: null, lt: new Date() },
    },
    data: { tier: 1 },
  });
  return true;
}

/**
 * Resolves the EFFECTIVE tier for a userId from the DB, applying the lazy
 * premium-reversion first. This is what the direct premium gates call
 * (browser-profiles, browser-sessions, jobs, trial.ts, automation-run) instead
 * of reading `{ tier: true }` raw — otherwise a raw read would keep returning
 * the stale tier:5 after expiry and the reversion in getCurrentUser() alone
 * wouldn't actually revoke access at these gates.
 *
 * `client` is any Prisma handle exposing user.findUnique/updateMany (the
 * singleton `prisma`/`db`, or a `tx` transaction client). Returns `null` if the
 * user no longer exists.
 */
export async function resolveUserTier(
  client: Prisma.TransactionClient,
  userId: string,
): Promise<number | null> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { tier: true, premiumExpiresAt: true },
  });
  if (!user) return null;
  const reverted = await applyPremiumReversionWith(
    client,
    userId,
    user.tier,
    user.premiumExpiresAt,
  );
  return reverted ? 1 : user.tier;
}

/**
 * The one gate every SpaceWorker exit-node use should check (regional mailbox
 * send, private-browser proxy, extraction routing): premium tier AND not
 * admin-restricted. A restricted premium user keeps every other premium
 * feature — this only ever affects node access specifically.
 */
export async function canUseExitNodes(
  client: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const tier = await resolveUserTier(client, userId);
  if (tier === null || tier < PREMIUM_TIER) return false;
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { nodeAccessRestricted: true },
  });
  return !user?.nodeAccessRestricted;
}

/**
 * Like applyPremiumReversion, but takes a client handle (for tx-consistency /
 * singletons) rather than the imported `db` singleton.
 */
export async function applyPremiumReversionWith(
  client: Prisma.TransactionClient,
  userId: string,
  tier: number,
  premiumExpiresAt: Date | null,
): Promise<boolean> {
  // TASK_181 — mirror of applyPremiumReversion: tier 3 shares the term column.
  if (tier < PREMIUM_TIER && tier !== XDEVICE_TIER) return false;
  if (premiumExpiresAt === null) return false; // grandfathered — never downgrade
  if (premiumExpiresAt.getTime() > Date.now()) return false;
  await client.user.updateMany({
    where: {
      id: userId,
      tier: { in: [PREMIUM_TIER, XDEVICE_TIER] },
      premiumExpiresAt: { not: null, lt: new Date() },
    },
    data: { tier: 1 },
  });
  return true;
}

/**
 * Grants (or extends, stacking) premium for `userId` by `days` from max(now,
 * current expiry). Sets tier to 5 and premiumExpiresAt. Returns the new expiry.
 * Used by the admin grant/extend route; identical stacking semantics to Vantra's
 * extendPremium (max-then-add) so early renewals accumulate rather than reset.
 */
export async function grantPremium(userId: string, days: number): Promise<Date> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { tier: true, premiumExpiresAt: true },
  });
  const now = Date.now();
  const base =
    user.premiumExpiresAt && user.premiumExpiresAt.getTime() > now
      ? user.premiumExpiresAt
      : new Date(now);
  const expiry = new Date(base.getTime() + days * DAY_MS);
  await db.user.update({
    where: { id: userId },
    data: { tier: PREMIUM_TIER, premiumExpiresAt: expiry },
  });
  return expiry;
}

/**
 * TASK_181 P3 (step 27) — grants (or extends, stacking) a tier-3 XDevice term
 * for `userId` by `days` from max(now, current expiry) — the SAME stacking
 * shape as grantPremium, so an early renewal accumulates rather than resets.
 *
 * HARD RULE (owner): an ACTIVE tier-5 user is NEVER lowered — a wrapper
 * purchase must not downgrade Premium. In that case nothing is written and
 * null is returned (the payment still stands; the admin decides any remedy).
 *
 * The expiry is server/admin-side only — no non-admin surface ever renders it
 * (owner: "never show it on ui how long the premium is for").
 *
 * Returns the new expiry, or null when the never-lower rule fired.
 */
export async function grantXDeviceTerm(
  userId: string,
  days: number = PREMIUM_DAYS_PER_CHARGE,
): Promise<Date | null> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { tier: true, premiumExpiresAt: true },
  });
  const now = Date.now();
  // Tier 5 live (incl. grandfathered NULL expiry — live forever) → no-op.
  if (user.tier >= PREMIUM_TIER && (user.premiumExpiresAt === null || user.premiumExpiresAt.getTime() > now)) {
    return null;
  }
  const base =
    user.premiumExpiresAt && user.premiumExpiresAt.getTime() > now
      ? user.premiumExpiresAt
      : new Date(now);
  const expiry = new Date(base.getTime() + days * DAY_MS);
  await db.user.update({
    where: { id: userId },
    data: { tier: XDEVICE_TIER, premiumExpiresAt: expiry },
  });
  return expiry;
}

export { DAY_MS };