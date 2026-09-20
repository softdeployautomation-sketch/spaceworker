import "server-only";

import { decodeLicenseKey, exeLicenseSecret, generateLicenseKey } from "./exe-license";
import { db } from "./db";
import { getProduct } from "./products";
import { notifyAdmin } from "./telegram";
import { sendEmail, exeTransferCompletedEmailHtml } from "./email";

// Task 47 — the shared "claim a license to one machine" mechanism.
//
// The admin tool (app/api/admin/exe-licenses) and the desktop EXE's own
// auto-bind call (app/api/exe-license/auto-bind, triggered by pasting a fresh
// key straight into the app — no manual Device ID entry anywhere, see that
// route's comment) call this one function. It is the ONLY place a machine
// binding is written:
//
//   1. Rejects a license already bound to a DIFFERENT machine — never silently
//      overwrite (that's the DRM hole this task closes).
//   2. Is idempotent for the SAME machine — a double-submit re-returns the already
//      issued bound key instead of erroring.
//   3. Re-signs the ORIGINAL unbound key via generateLicenseKey() with `machineId`
//      threaded into the payload's `machine_id`, preserving the ORIGINAL key's
//      exact `expires_at` (a claim binds a machine; it must never reset or extend
//      the 180-day term).
//   4. Persists the binding on the ExeLicense row.
//
// No change to the offline validator: it already enforces machine_id against the
// current machine when the field is present.

export class LicenseBindError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "already_bound"
      | "invalid_original"
      | "not_configured"
      | "invalid_machine"
      | "machine_taken",
  ) {
    super(message);
    this.name = "LicenseBindError";
  }
}

/**
 * One machine, one account — never the other way round. True when a
 * DIFFERENT user's still-valid ExeLicense row is currently bound to
 * `machineId`. A duplicate row under the SAME user (pre-existing debris, not
 * this check's job) is deliberately excluded by filtering on userId in the
 * query itself, not just by license id. Confirmed live (2026-09-19): nothing
 * previously stopped a second account from binding to a machine another
 * account's license was already active on — same test VM used for two buyer
 * accounts produced two simultaneously "Licensed" rows, a real cross-account
 * collision, not per-license reuse. Checked before every write that sets
 * boundMachineId (bind AND transfer).
 */
async function machineTakenByAnotherAccount(machineId: string, licenseUserId: string): Promise<boolean> {
  const now = new Date();
  const candidates = await db.exeLicense.findMany({
    where: { boundMachineId: machineId, userId: { not: licenseUserId } },
    select: { licenseKey: true },
  });
  return candidates.some((c) => keyExpiryIsAfter(c.licenseKey, now));
}

export interface BindExeLicenseResult {
  boundLicenseKey: string;
  boundMachineId: string;
  boundMachineLabel: string | null;
  boundAt: Date;
  product: string;
  productName: string;
  licensee: string;
  plan: string;
  /** The preserved (original key's) expiry — verified identical to the source. */
  expiresAt: Date;
}

/**
 * Binds an ExeLicense to a single machine. `exeLicenseId` identifies the row;
 * `machineId` is the buyer's device id (getMachineId() output). Ownership /
 * "is the caller allowed to act on this license" is the CALLER's responsibility
 * (admin route checks the admin session + a matching email; the self-service
 * route checks the session's user owns the row) — this function only enforces
 * the one-machine invariant and the re-sign.
 */
export async function bindExeLicenseToMachine(input: {
  exeLicenseId: string;
  machineId: string;
  machineLabel?: string | null;
}): Promise<BindExeLicenseResult> {
  const machineId = input.machineId.trim().toLowerCase();
  if (!machineId) {
    throw new LicenseBindError("Enter the device ID (Machine ID) to bind this license to.", "invalid_machine");
  }
  // Fail-closed: never mint a bound key without the signing secret.
  let secret: string;
  try {
    secret = exeLicenseSecret();
  } catch {
    throw new LicenseBindError(
      "EXE license signing is not configured on the server.",
      "not_configured",
    );
  }
  void secret; // signing happens inside generateLicenseKey(); the getter above guarantees it's set

  const license = await db.exeLicense.findUnique({ where: { id: input.exeLicenseId } });
  if (!license) {
    throw new LicenseBindError("License not found.", "not_found");
  }

  const existingBound = license.boundMachineId;
  if (existingBound) {
    if (existingBound.trim().toLowerCase() === machineId) {
      // Idempotent re-claim of the SAME machine: return the already-issued bound key
      // rather than an error (safe against double-submit / retries). This also
      // preserves the original claim timestamp in boundAt.
      return {
        boundLicenseKey: license.boundLicenseKey ?? "",
        boundMachineId: existingBound,
        boundMachineLabel: license.boundMachineLabel ?? null,
        boundAt: license.boundAt ?? new Date(),
        product: license.product,
        productName: getProduct(license.product)?.name ?? license.product,
        licensee: (await buyerEmail(license.userId)) ?? "",
        plan: "",
        expiresAt: originalExpiry(license.licenseKey),
      };
    }
    // Never overwrite a binding set for a different machine.
    throw new LicenseBindError(
      "This license is already active on another device. To move it to a new machine, contact support — a transfer is a deliberate admin action.",
      "already_bound",
    );
  }

  // One machine, one account: refuse to bind onto a device another buyer's
  // license already occupies.
  if (await machineTakenByAnotherAccount(machineId, license.userId)) {
    throw new LicenseBindError(
      "This device already has an active license under a different account. Deactivate it there first, or contact support.",
      "machine_taken",
    );
  }
// Decode the original unbound key to re-sign with the SAME licensee/plan/product
  // and the SAME expiry (never reset the 180-day clock).
  const original = decodeLicenseKey(license.licenseKey);
  if (!original || !original.licensee || !original.product) {
    throw new LicenseBindError(
      "Could not decode the original license key — it can't be claimed. Contact support.",
      "invalid_original",
    );
  }
  const originalExpiryDate = parsePythonIsoformat(original.expires_at);
  if (!originalExpiryDate) {
    throw new LicenseBindError(
      "The original license key has an unreadable expiry — it can't be claimed. Contact support.",
      "invalid_original",
    );
  }
  const product = getProduct(original.product);
  if (!product) {
    throw new LicenseBindError(
      `Unknown product "${original.product}" on this license.`,
      "invalid_original",
    );
  }
  const plan = original.plan || product.plan || product.id;

  const bound = generateLicenseKey({
    licensee: original.licensee,
    plan,
    product: original.product,
    machineId,
    expiresAt: originalExpiryDate, // preserve the original term exactly
  });

  const now = new Date();
  await db.exeLicense.update({
    where: { id: license.id },
    data: {
      boundMachineId: machineId,
      boundMachineLabel: input.machineLabel?.trim() ? input.machineLabel.trim() : null,
      boundLicenseKey: bound.licenseKey,
      boundAt: now,
    },
  });

  void notifyAdmin(
    `EXE license bound: ${original.licensee} — ${getProduct(license.product)?.name ?? license.product} — device "${input.machineLabel?.trim() || machineId}"`,
  );

  return {
    boundLicenseKey: bound.licenseKey,
    boundMachineId: machineId,
    boundMachineLabel: input.machineLabel?.trim() ? input.machineLabel.trim() : null,
    boundAt: now,
    product: license.product,
    productName: product.name,
    licensee: original.licensee,
    plan,
    expiresAt: originalExpiryDate,
  };
}

// ===========================================================================
// Task 47 addition — ADMIN DEVICE TRANSFER (move an already-bound license).
//
// It is a SEPARATE function/action from bindExeLicenseToMachine() — that one is
// correctly one-way (it refuses to overwrite a binding for a different machine,
// which is exactly the DRM guarantee this whole task preserves). Transfer is the
// ONE place overwriting an existing binding is intentional: a deliberate admin
// support action (hardware replacement, machine lost/stolen) that moves a valid
// license to a new device.
//
// Differences from bind:
//   * Does NOT reject when the license is already bound — instead it REQUIRES a
//     current binding (you can't "transfer" a never-claimed, unbound license;
//     that's the plain bind/claim flow) and moves it to the new device.
//   * Re-signs the ORIGINAL unbound key (ExeLicense.licenseKey, never the
//     currently-bound key) with the NEW machineId — exactly like bind — so the
//     true original expires_at is preserved and the term is never reset/extended.
//   * Writes the new binding and a durable ExeLicenseTransfer audit row in ONE
//     transaction, so the rebind and its audit trail can never desync — the
//     record of "who moved what, when" survives for support disputes.
//
// No self-service caller uses this — it stays admin/support-only (letting a
// buyer freely re-bind would defeat the one-device-per-license guarantee).
// ===========================================================================

export class LicenseTransferError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "not_bound"
      | "invalid_original"
      | "not_configured"
      | "invalid_machine"
      | "machine_taken",
  ) {
    super(message);
    this.name = "LicenseTransferError";
  }
}

export interface TransferExeLicenseResult {
  boundLicenseKey: string;
  boundMachineId: string;
  boundMachineLabel: string | null;
  /** The machine the license was moved AWAY from. */
  movedFromMachineId: string | null;
  /** When the transfer (the binding overwrite) happened. */
  movedAt: Date;
  product: string;
  productName: string;
  licensee: string;
  plan: string;
  /** The preserved (original key's) expiry — verified identical to the source. */
  expiresAt: Date;
}

/**
 * MOVES an already-bound ExeLicense from its current machine to `newMachineId`.
 * This is the one deliberate overwrite point in the system — an admin/support
 * action — so unlike bindExeLicenseToMachine it does NOT reject an existing
 * binding, but it DOES refuse to act on a not-yet-bound (unclaimed) license.
 * `newMachineId` is the buyer's new device id (getMachineId() output). Ownership
 * / "is the caller allowed to act on this license" is the CALLER's responsibility
 * (the admin route checks the admin session + a matching email) — this function
 * only enforces the transfer invariant and the re-sign.
 *
 * The binding overwrite and the audit row are written in a single transaction.
 */
export async function transferExeLicenseToMachine(input: {
  exeLicenseId: string;
  newMachineId: string;
  newMachineLabel?: string | null;
  /** Optional support note recorded on the audit row (e.g. "replaced laptop"). */
  note?: string | null;
}): Promise<TransferExeLicenseResult> {
  const machineId = input.newMachineId.trim().toLowerCase();
  if (!machineId) {
    throw new LicenseTransferError("Enter the new Device ID to move this license to.", "invalid_machine");
  }
  // Fail-closed: never mint a bound key without the signing secret.
  let secret: string;
  try {
    secret = exeLicenseSecret();
  } catch {
    throw new LicenseTransferError("EXE license signing is not configured on the server.", "not_configured");
  }
  void secret; // signing happens inside generateLicenseKey(); the getter above guarantees it's set

  const license = await db.exeLicense.findUnique({ where: { id: input.exeLicenseId } });
  if (!license) {
    throw new LicenseTransferError("License not found.", "not_found");
  }

  const fromMachineId = license.boundMachineId?.trim().toLowerCase() || null;
  if (!fromMachineId) {
    // You can't "transfer" a license that was never claimed — that's the plain
    // bind/claim flow, not the admin replacement flow this action exists for.
    throw new LicenseTransferError(
      "This license isn't bound to a device yet — claim (bind) it first, then transfer if it needs to move.",
      "not_bound",
    );
  }

  if (fromMachineId === machineId) {
    // Idempotent re-transfer to the SAME machine: return the already-issued bound
    // key rather than erroring (safe against double-submit / retries). No new
    // audit row — nothing was actually moved.
    return {
      boundLicenseKey: license.boundLicenseKey ?? "",
      boundMachineId: fromMachineId,
      boundMachineLabel: license.boundMachineLabel ?? null,
      movedFromMachineId: fromMachineId,
      movedAt: license.boundAt ?? new Date(),
      product: license.product,
      productName: getProduct(license.product)?.name ?? license.product,
      licensee: (await buyerEmail(license.userId)) ?? "",
      plan: "",
      expiresAt: originalExpiry(license.licenseKey),
    };
  }

  // One machine, one account: refuse to move onto a device another buyer's
  // license already occupies.
  if (await machineTakenByAnotherAccount(machineId, license.userId)) {
    throw new LicenseTransferError(
      "This device already has an active license under a different account. Deactivate it there first, or contact support.",
      "machine_taken",
    );
  }
  // Decode the ORIGINAL unbound key to re-sign with the SAME licensee/plan/product
  // and the SAME expiry (never reset the 180-day clock). We ALWAYS decode
  // ExeLicense.licenseKey — the never-modified original — never the currently
  // bound key, so a chain of transfers never drifts the expiry.
  const original = decodeLicenseKey(license.licenseKey);
  if (!original || !original.licensee || !original.product) {
    throw new LicenseTransferError(
      "Could not decode the original license key — it can't be transferred. Contact support.",
      "invalid_original",
    );
  }
  const originalExpiryDate = parsePythonIsoformat(original.expires_at);
  if (!originalExpiryDate) {
    throw new LicenseTransferError(
      "The original license key has an unreadable expiry — it can't be transferred. Contact support.",
      "invalid_original",
    );
  }
  const product = getProduct(original.product);
  if (!product) {
    throw new LicenseTransferError(`Unknown product "${original.product}" on this license.`, "invalid_original");
  }
  const plan = original.plan || product.plan || product.id;

  const bound = generateLicenseKey({
    licensee: original.licensee,
    plan,
    product: original.product,
    machineId,
    expiresAt: originalExpiryDate, // preserve the original term exactly
  });

  const now = new Date();
  const newMachineLabel = input.newMachineLabel?.trim() ? input.newMachineLabel.trim() : null;
  const note = input.note?.trim() ? input.note.trim() : null;

  // ONE atomic write: the binding overwrite + the append-only audit row, so a
  // crash can never leave a moved binding without a record (or vice-versa).
  await db.$transaction(async (tx) => {
    await tx.exeLicense.update({
      where: { id: license.id },
      data: {
        boundMachineId: machineId,
        boundMachineLabel: newMachineLabel,
        boundLicenseKey: bound.licenseKey,
        boundAt: now,
      },
    });
    await tx.exeLicenseTransfer.create({
      data: {
        exeLicenseId: license.id,
        userId: license.userId,
        fromMachineId,
        toMachineId: machineId,
        fromMachineLabel: license.boundMachineLabel,
        toMachineLabel: newMachineLabel,
        note,
        transferredAt: now,
      },
    });
  });

  void notifyAdmin(
    `EXE license TRANSFERRED: ${original.licensee} — ${getProduct(license.product)?.name ?? license.product} — moved to device "${newMachineLabel || machineId}"${note ? ` (${note})` : ""}`,
  );
  // Task 49 fix — the licensee must find out immediately, not just the
  // operator (notifyAdmin above). Best-effort: a failed send must never
  // undo an already-committed transfer, and every caller of this function
  // (admin, password-login, the code-confirmed auto-bind path, a fresh
  // purchase's payment-status) gets this for free from one place.
  void sendEmail({
    to: original.licensee,
    subject: `Your ${getProduct(license.product)?.name ?? "SpaceWorker"} license moved devices`,
    html: exeTransferCompletedEmailHtml({
      productName: getProduct(license.product)?.name ?? license.product,
      machineLabel: newMachineLabel || machineId,
    }),
    eventType: "exe_license_transferred",
  }).catch((err) => {
    console.error("[exe-license] transfer succeeded but owner notification failed:", err instanceof Error ? err.message : String(err));
  });

  return {
    boundLicenseKey: bound.licenseKey,
    boundMachineId: machineId,
    boundMachineLabel: newMachineLabel,
    movedFromMachineId: fromMachineId,
    movedAt: now,
    product: license.product,
    productName: product.name,
    licensee: original.licensee,
    plan,
    expiresAt: originalExpiryDate,
  };
}

/**
 * Clears an ExeLicense's machine binding entirely, returning it to the
 * "unclaimed" state a freshly-issued license starts in — the next bind
 * (self-service or admin) re-signs a fresh bound key from the ORIGINAL
 * unbound licenseKey, exactly as if this license had never been claimed.
 * Admin-only support/testing action (e.g. resetting a test account's
 * license to walk through the real signup flow again) — deliberately NOT
 * exposed to self-service, same reasoning as transfer: a buyer stripping
 * their own binding and handing the license to someone else is the exact
 * DRM hole bindExeLicenseToMachine's one-machine invariant exists to close.
 * Idempotent: unbinding an already-unbound license is a harmless no-op.
 */
export async function unbindExeLicense(exeLicenseId: string): Promise<{ id: string; wasBound: boolean }> {
  const license = await db.exeLicense.findUnique({ where: { id: exeLicenseId } });
  if (!license) {
    throw new LicenseBindError("License not found.", "not_found");
  }
  const wasBound = !!license.boundMachineId;
  await db.exeLicense.update({
    where: { id: exeLicenseId },
    data: { boundMachineId: null, boundMachineLabel: null, boundLicenseKey: null, boundAt: null },
  });
  return { id: exeLicenseId, wasBound };
}

async function buyerEmail(userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email ?? null;
}

/** Parses Python's isoformat with a trailing 'Z' so Date treats it as UTC. */
function parsePythonIsoformat(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The exact `expires_at` of a key's payload, as a Date (UTC). */
export function originalExpiry(licenseKey: string): Date {
  const payload = decodeLicenseKey(licenseKey);
  return parsePythonIsoformat(payload?.expires_at ?? "") ?? new Date(0);
}

/**
 * True when a key's decoded `expires_at` is after `now` (unreadable/absent =
 * expired). Exported for the admin issue action's duplicate-prevention check
 * (2026-09-19) — "does this user already have a usable license".
 */
export function keyExpiryIsAfter(licenseKey: string, now: Date): boolean {
  return originalExpiry(licenseKey).getTime() > now.getTime();
}