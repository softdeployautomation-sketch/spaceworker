import "server-only";

import { getSession } from "./auth";
import { db } from "./db";
import { applyPremiumReversion } from "./premium";

/**
 * Loads the current user from the session cookie with a fresh, authoritative
 * DB read (rather than trusting the JWT payload alone). Returns null if there's
 * no valid session or the user row no longer exists.
 *
 * Task 55 — applies the lazy premium-reversion check on every read: a tier-5
 * user whose premiumExpiresAt (non-null) has passed is flipped back to tier 1
 * right here, so an expired grant stops working without any cron. Pre-fix
 * grandfathered users (premiumExpiresAt === null) are never touched.
 */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;

  const user = await db.user.findUnique({ where: { id: session.sub } });
  if (!user) return null;

  await applyPremiumReversion(user.id, user.tier, user.premiumExpiresAt ?? null);
  if (user.tier < 5) return user;
  if (user.premiumExpiresAt === null) return user;
  if (user.premiumExpiresAt.getTime() > Date.now()) return user;
  // Expired — re-read after the downgrade so the returned user reflects reality.
  return db.user.findUnique({ where: { id: user.id } });
}