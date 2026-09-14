import "server-only";

import { createHash, randomBytes } from "crypto";

// Task 45 — the short-lived, single-use claim token behind the "view my
// license" link emailed to an EXE buyer (`/api/exe-license/claim?token=...`).
// Same shape/discipline as the Telegram link tokens from Task 39
// (`lib/telegram.ts`): `<crypto-random>.<expiryEpochMs>`, so an "expired" token
// can never be mistaken for a valid one. Only the SHA-256 hash is ever stored on
// the ExeLicense row (never the raw token), mirroring VerificationCode's
// discipline — a leaked DB dump can't be replayed to claim a license.
//
// Single-use: the claim route marks the token consumed atomically on success, so
// a token cannot be replayed from a second browser.
export const LICENSE_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Generates a fresh claim token: `<crypto-random>.<expiresEpochMs>`. */
export function generateLicenseClaimToken(): string {
  const random = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + LICENSE_CLAIM_TTL_MS;
  return `${random}.${expiresAt}`;
}

/** SHA-256 hex digest — the only thing stored on the ExeLicense row. */
export function hashLicenseClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface ParsedLicenseClaimToken {
  random: string;
  expiresAt: number;
}

/**
 * Parse a claim token into its { random, expiresAt } halves without trusting
 * either (the random half is matched against the stored hash; expiry is checked
 * against the stored column by the route). Returns null on a malformed shape.
 */
export function parseLicenseClaimToken(raw: string): ParsedLicenseClaimToken | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const random = raw.slice(0, dot);
  const expiresAt = Number(raw.slice(dot + 1));
  if (!Number.isFinite(expiresAt)) return null;
  return { random, expiresAt };
}