import "server-only";

import { createHash } from "node:crypto";

import { db } from "@/lib/db";

import { canonicalAupText, CYBERLAB_AUP_VERSION } from "./aup";

// TASK_156 C1 (PLAN_TASK_156 §6, §7 C1, §12.9) — the consent engine beneath the
// AUP gate.
//
// `LabConsent` is APPEND-ONLY (§5.2.6: "LabConsent never updated, only superseded").
// A consent row records (userId, termsVersion, scope, ip, signedAt) plus a `hash`
// over the CANONICAL AUP text for that version — so the exact wording a user
// accepted stays provable even after we revise the AUP. The gate
// (lib/lab/gate.ts) only honours consent for the CURRENT
// AdminSetting.cyberlabConsentTermsVersion; bumping the dial forces re-acceptance
// because a stale-version row simply does not match.
//
// There is deliberately no update or delete here. That is the point.

/** The AUP scope stored on the row. The AUP covers the lab (and mirrors hosting's). */
export const LAB_CONSENT_SCOPE = "lab";

/**
 * SHA-256 over userId + termsVersion + the canonical AUP text. Deterministic and
 * public (no secret) — it exists so a later reviewer can prove which text a given
 * consent row was taken against, not to hide anything.
 */
export function consentHash(userId: string, termsVersion: string): string {
  return createHash("sha256")
    .update(`${userId}:${termsVersion}:${canonicalAupText(termsVersion)}`, "utf8")
    .digest("hex");
}

export interface ConsentRow {
  id: string;
  userId: string;
  termsVersion: string;
  scope: string;
  signedAt: Date;
  hash: string;
}

/**
 * The user's consent row for the given version (default: the current AUP version),
 * or null. Append-only table => at most one row per (userId, termsVersion).
 */
export async function currentConsent(
  userId: string,
  termsVersion: string = CYBERLAB_AUP_VERSION,
): Promise<ConsentRow | null> {
  return db.labConsent.findFirst({
    where: { userId, termsVersion },
    orderBy: { signedAt: "desc" },
    select: { id: true, userId: true, termsVersion: true, scope: true, signedAt: true, hash: true },
  });
}

/**
 * Record acceptance of the CURRENT AUP version. Idempotent: if the user already
 * consented to this version, the existing row is returned untouched (never
 * rewritten — append-only). Otherwise a new row is appended with the canonical hash
 * and the caller's IP (best-effort, from the request headers; may be null behind a
 * proxy that does not forward it).
 *
 * Returns the row in force after the call plus whether this call created it, so the
 * API can report "already accepted" vs "recorded".
 */
export async function recordConsent(opts: {
  userId: string;
  termsVersion?: string;
  scope?: string;
  ip?: string | null;
}): Promise<{ row: ConsentRow; created: boolean }> {
  const termsVersion = opts.termsVersion ?? CYBERLAB_AUP_VERSION;
  const existing = await currentConsent(opts.userId, termsVersion);
  if (existing) return { row: existing, created: false };

  const row = await db.labConsent.create({
    data: {
      userId: opts.userId,
      termsVersion,
      scope: opts.scope ?? LAB_CONSENT_SCOPE,
      ip: opts.ip ?? null,
      hash: consentHash(opts.userId, termsVersion),
    },
    select: { id: true, userId: true, termsVersion: true, scope: true, signedAt: true, hash: true },
  });
  return { row, created: true };
}

/**
 * Best-effort client IP from the request headers, mirroring
 * app/api/hosting/files/route.ts (x-forwarded-for first hop, else x-real-ip).
 * Never trusted for authorization — stored only as consent provenance.
 */
export function clientIp(req: Request): string | null {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim() ||
    null
  );
}
