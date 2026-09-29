import "server-only";

import { db } from "./db";
import { notifyAdmin } from "./telegram";

// TASK_145 (Phase 5) — the EXE licence revocation seam (senior track §3 D2).
//
// ONE module owns every read and write of the `ExeLicenseRevocation` table.
// T5/T6/T9/T11/T12/T13 import these three functions rather than touching the
// table directly, so a revocation decision is made in exactly one place — and
// it can only ever be made against the DB row, never from a client flag or the
// decoded licence payload (senior track §6 item 14).
//
// Revocation can only be enforced where the app already talks to our servers
// (bind / transfer / issue-reuse / launch-time eligibility) because offline
// validation is a design invariant: `lib/exe-license-validator.ts` is frozen
// and knows nothing about revocation (senior track §3 D5 / §6 item 1).
//
// Un-revoking DELETES the row — a reversible admin toggle, not a financial
// ledger (senior track §3 D1). Both directions alert the owner, so support
// keeps an operational trail even though the row itself is gone.

export class LicenseRevocationError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_owner",
  ) {
    super(message);
    this.name = "LicenseRevocationError";
  }
}

/**
 * True when the licence currently has a revocation row. This is the ONLY
 * revocation read path — never infer revocation from the key, a payload field,
 * a DB column on `ExeLicense`, or a client-supplied flag (senior track §3 D2).
 */
export async function isExeLicenseRevoked(exeLicenseId: string): Promise<boolean> {
  const row = await db.exeLicenseRevocation.findUnique({
    where: { exeLicenseId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Cancel a licence. Idempotent — `upsert` on the unique `exeLicenseId`, so a
 * double-click re-writes the same row instead of raising a unique-constraint
 * 500. The licence is also ownership-checked first, mirroring the gate every
 * other admin action uses (`app/api/admin/exe-licenses/route.ts`).
 */
export async function revokeExeLicense(input: {
  exeLicenseId: string;
  userId: string;
  reason?: string | null;
  revokedBy?: string | null;
}): Promise<void> {
  const license = await db.exeLicense.findUnique({
    where: { id: input.exeLicenseId },
    select: { id: true, userId: true, product: true, user: { select: { email: true } } },
  });
  if (!license) {
    throw new LicenseRevocationError("License not found.", "not_found");
  }
  if (license.userId !== input.userId) {
    throw new LicenseRevocationError("This license does not belong to that account.", "not_owner");
  }

  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  const revokedBy =
    typeof input.revokedBy === "string" && input.revokedBy.trim() ? input.revokedBy.trim() : null;

  await db.exeLicenseRevocation.upsert({
    where: { exeLicenseId: license.id },
    create: {
      exeLicenseId: license.id,
      userId: license.userId,
      reason,
      revokedBy,
    },
    update: {
      reason,
      revokedBy,
    },
  });

  void notifyAdmin(
    `EXE license revoked: ${license.user.email} — ${license.product}${reason ? ` — ${reason}` : ""}`,
  );
}

/**
 * Restore a cancelled licence by deleting its revocation row. Idempotent —
 * deleting when nothing is revoked is a no-op, never a throw (senior track
 * §3 D2). The owner is still alerted, so the trail records the action even
 * though the row it removes is already gone.
 */
export async function unrevokeExeLicense(exeLicenseId: string): Promise<void> {
  const license = await db.exeLicense.findUnique({
    where: { id: exeLicenseId },
    select: { product: true, user: { select: { email: true } } },
  });

  await db.exeLicenseRevocation.deleteMany({ where: { exeLicenseId } });

  void notifyAdmin(
    `EXE license restored: ${license?.user.email ?? exeLicenseId} — ${license?.product ?? "unknown product"}`,
  );
}
