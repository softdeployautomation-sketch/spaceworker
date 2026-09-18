import "server-only";

import { decodeLicenseKey, exeLicenseSecret, generateLicenseKey } from "./exe-license";
import { db } from "./db";
import { getProduct } from "./products";

// Task 47 — the shared "claim a license to one machine" mechanism.
//
// Both the admin tool (app/api/admin/exe-licenses) and the buyer's self-service
// form (app/api/exe-license/bind) call this one function. It is the ONLY place a
// machine binding is written:
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
    readonly code: "not_found" | "already_bound" | "invalid_original" | "not_configured" | "invalid_machine",
  ) {
    super(message);
    this.name = "LicenseBindError";
  }
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
function originalExpiry(licenseKey: string): Date {
  const payload = decodeLicenseKey(licenseKey);
  return parsePythonIsoformat(payload?.expires_at ?? "") ?? new Date(0);
}