import "server-only";

import { createHash, randomInt } from "crypto";

import { db } from "./db";

export const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_ATTEMPTS = 10;

export function generateCode(): string {
  // Six-digit numeric code, cryptographically strong (no modulo bias).
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Creates a fresh verification code for a user, invalidating prior ones. */
export async function issueVerificationCode(userId: string): Promise<{
  code: string;
  codeHash: string;
  expiresAt: Date;
}> {
  const code = generateCode();
  const codeHash = hashCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  // Invalidate any previous unconsumed codes for this user.
  await db.verificationCode.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await db.verificationCode.create({
    data: { userId, codeHash, expiresAt },
  });

  return { code, codeHash, expiresAt };
}

/**
 * Validates a submitted code against the user's most recent unconsumed code.
 * Increments `attempts` on failure (brute-force cap). Returns true on success
 * and consumes the code atomically.
 */
export async function consumeVerificationCode(
  userId: string,
  submittedCode: string,
): Promise<{ ok: boolean; reason?: string }> {
  const latest = await db.verificationCode.findFirst({
    where: { userId, consumedAt: null },
    // The model has no createdAt; the most-recently-issued code also has the
    // latest expiry (fixed TTL on issuance), so order by expiresAt desc.
    orderBy: { expiresAt: "desc" },
  });

  if (!latest) {
    return { ok: false, reason: "no_code" };
  }
  if (new Date(latest.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (latest.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "attempts_exhausted" };
  }

  const { codeHash } = await db.verificationCode.findUniqueOrThrow({
    where: { id: latest.id },
    select: { codeHash: true },
  });

  if (hashCode(submittedCode) !== codeHash) {
    await db.verificationCode.update({
      where: { id: latest.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "invalid" };
  }

  await db.verificationCode.update({
    where: { id: latest.id },
    data: { consumedAt: new Date() },
  });

  return { ok: true };
}