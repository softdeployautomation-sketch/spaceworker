import "server-only";

import { db } from "./db";
import { isPremiumWithReversion, applyPremiumReversion } from "./premium";

// Task 92 / plan §COMMERCIAL C1 — THE entitlement gate. Every feature checks
// capabilities here, never tiers: a tier number is storage, `hasEntitlement`
// is the decision. Tier 5 implicitly allows every key (via lib/premium.ts
// lazy-reversion semantics — NULL premiumExpiresAt on an existing tier-5 user
// is GRANDFATHERED and never expires), so a UserEntitlement row is only
// needed for module/admin grants that must survive a premium downgrade.
export const ENTITLEMENT_KEYS = ["extractor", "mailer", "assistant", "devices", "cyberlab"] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export function isEntitlementKey(value: unknown): value is EntitlementKey {
  return typeof value === "string" && (ENTITLEMENT_KEYS as readonly string[]).includes(value);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EntitlementDecision {
  allowed: boolean;
  // Why: "premium" (tier 5 covers it), "grant" (a UserEntitlement row), or
  // "none". reason "expired" means a grant existed but its term passed (and
  // has now been lazily stamped revoked).
  reason: "premium" | "grant" | "none" | "expired";
}

/**
 * The single gate. Loads the user's tier WITH premiumExpiresAt, applies the
 * Task 55 lazy reversion (safe to call on every read — no-op unless expired),
 * and only then falls back to the UserEntitlement row. Expired grants are
 * lazily stamped revokedAt (once) and denied.
 */
export async function hasEntitlement(userId: string, key: EntitlementKey): Promise<EntitlementDecision> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, tier: true, premiumExpiresAt: true },
  });
  if (!user) return { allowed: false, reason: "none" };

  if (isPremiumWithReversion(user)) return { allowed: true, reason: "premium" };
  // Persist the Task 55 lazy downgrade if the premium term just passed.
  await applyPremiumReversion(user.id, user.tier, user.premiumExpiresAt);

  const grant = await db.userEntitlement.findUnique({
    where: { userId_key: { userId, key } },
  });
  if (!grant || grant.revokedAt) return { allowed: false, reason: grant?.revokedAt ? "expired" : "none" };

  if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) {
    // Lazy expiry, mirroring premiumExpiresAt: stamp once, deny from now on.
    await db.userEntitlement.updateMany({
      where: { id: grant.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { allowed: false, reason: "expired" };
  }
  return { allowed: true, reason: "grant" };
}

/**
 * Grant (or extend) an entitlement. Upsert by (userId, key): re-granting
 * clears any revocation stamp and (optionally) sets/extends the term.
 * expiresInDays undefined => never expires.
 */
export async function grantEntitlement(opts: {
  userId: string;
  key: EntitlementKey;
  source: "module" | "admin_grant" | "trial";
  expiresInDays?: number;
}): Promise<void> {
  const expiresAt =
    opts.expiresInDays !== undefined ? new Date(Date.now() + opts.expiresInDays * DAY_MS) : null;
  await db.userEntitlement.upsert({
    where: { userId_key: { userId: opts.userId, key: opts.key } },
    create: { userId: opts.userId, key: opts.key, source: opts.source, expiresAt },
    // A fresh grant always wins over a stale revoked/expired row.
    update: { source: opts.source, expiresAt, revokedAt: null, grantedAt: new Date() },
  });
}

/** Stamp revokedAt (reversible — re-granting clears it). Idempotent. */
export async function revokeEntitlement(userId: string, key: EntitlementKey): Promise<void> {
  await db.userEntitlement.updateMany({
    where: { userId, key, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * The effective set of keys a user holds right now (tier 5 => every key,
 * subject to the same lazy premium reversion; otherwise live grants).
 * Used by admin views and the entitlements API.
 */
export async function listEffectiveEntitlements(userId: string): Promise<{
  keys: EntitlementKey[];
  premium: boolean;
  grants: { key: EntitlementKey; source: string; expiresAt: Date | null; revokedAt: Date | null }[];
}> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, tier: true, premiumExpiresAt: true },
  });
  const premium = !!user && isPremiumWithReversion(user);
  if (user) await applyPremiumReversion(user.id, user.tier, user.premiumExpiresAt);

  const rows = await db.userEntitlement.findMany({ where: { userId } });
  const now = Date.now();
  const grants = rows.map((r) => ({
    key: r.key as EntitlementKey,
    source: r.source,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }));
  const live = grants.filter(
    (g) => !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now),
  );
  const keys = premium
    ? [...ENTITLEMENT_KEYS]
    : [...new Set(live.map((g) => g.key))];
  return { keys, premium, grants };
}