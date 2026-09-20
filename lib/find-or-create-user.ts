import "server-only";

import { randomBytes } from "crypto";

import { db } from "./db";
import { hashPassword } from "./auth";
import { notifyAdmin } from "./telegram";

// Extracted 2026-09-20 from app/api/billing/submit/route.ts's private
// findOrCreateUser — now also used by the admin "issue EXE license" route,
// so an admin can type ANY email and have it work like a real signup instead
// of requiring the buyer to already have an account. Same identity both
// callers need: an existing account is reused as-is; a brand-new one gets a
// random, unknowable password (nobody signs in with it directly — the
// license claim link is how they first reach the account) and MUST stay
// tier 0. The schema default is 1 (trial); a trial tier here would silently
// hand the full web product to someone who never signed up for it.
export interface FindOrCreateUserResult {
  userId: string;
  /** True only when this call just created the row (a genuinely new account). */
  created: boolean;
}

export async function findOrCreateUser(email: string): Promise<FindOrCreateUserResult> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { userId: existing.id, created: false };

  const randomPassword = randomBytes(24).toString("hex");
  const passwordHash = await hashPassword(randomPassword);
  const created = await db.user.create({
    data: { email, passwordHash, emailVerified: true, tier: 0 },
  });
  void notifyAdmin(`New SpaceWorker signup (inline/EXE): ${email}`);
  return { userId: created.id, created: true };
}
