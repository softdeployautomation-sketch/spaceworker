import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

import { decodeLicenseKey, LicensePayload } from "./exe-license";
import { getMachineId, validateMachineId } from "./machine-id";

// Offline license validation — a faithful port of ~/lead-extractor/app/license/
// validator.py. The desktop EXE validates keys FULLY offline with no server
// round-trip: it re-derives the HMAC-SHA256 over the key's payload with the
// embedded signing secret (the same secret the server issues with — it ships
// inside the binary exactly like the standalone's does), checks `expires_at`,
// and honours machine binding when the key carries `machine_id`/`machine_ids`.

export interface LicenseValidationOptions {
  /** Current machine ID. When omitted, the validator derives it on demand
   *  (only when the key is actually machine-bound) — mirroring validator.py. */
  currentMachineId?: string;
  /** Test seam — determine "now" explicitly. */
  now?: Date;
}

export interface LicenseValidation {
  valid: boolean;
  licensee: string;
  plan: string;
  /** The SpaceWorker EXE-variant ProductId this key was signed for
   *  ("extractor_exe" | "mailer_exe" | "combined_exe" | "automation_exe"). Empty
   *  for legacy keys minted before the field existed — which the activation route
   *  treats as a hard miss (fail-closed). */
  product: string;
  issuedAt: string;
  expiresAt: string;
  /** Parsed expiry (UTC) — convenience for callers that need the Date. */
  expiresAtDate: Date | null;
  error: string;
}

function result(
  valid: boolean,
  error: string,
  payload: LicensePayload | null = null,
): LicenseValidation {
  return {
    valid,
    licensee: payload?.licensee ?? "",
    plan: payload?.plan ?? "",
    product: payload?.product ?? "",
    issuedAt: payload?.issued_at ?? "",
    expiresAt: payload?.expires_at ?? "",
    expiresAtDate: parsePythonIsoformat(payload?.expires_at ?? ""),
    error,
  };
}

/**
 * Validates a license key offline against the signing secret. Mirrors
 * validator.py exactly:
 *   1. well-formed `<payload_b64>.<signature>`
 *   2. HMAC-SHA256 signature matches (constant-time compare)
 *   3. `expires_at` not in the past
 *   4. machine binding (if any) matches the current machine
 */
export async function validateLicenseKey(
  licenseKey: string,
  secret: string,
  opts: LicenseValidationOptions = {},
): Promise<LicenseValidation> {
  if (!licenseKey || !licenseKey.trim()) {
    return result(false, "No license key provided");
  }
  const parts = licenseKey.trim().split(".");
  if (parts.length !== 2) {
    return result(false, "Invalid license key format");
  }
  const [payloadB64, providedSignature] = parts;

  // 1. Signature — re-derive the HMAC and compare constant-time.
  if (!hmacMatch(payloadB64, providedSignature, secret)) {
    return result(false, "Invalid license key signature");
  }

  // 2. Decode the payload.
  const payload = decodeLicenseKey(licenseKey);
  if (!payload) return result(false, "Invalid license key format");

  // 3. Expiry.
  const expiresAt = parsePythonIsoformat(payload.expires_at);
  const now = opts.now ?? new Date();
  if (!expiresAt || now.getTime() > expiresAt.getTime()) {
    return result(false, "License key has expired", payload);
  }

  // 4. Machine binding — machine_ids (any match) or machine_id (exact match).
  const currentMachineId = opts.currentMachineId ?? (await getMachineId()).toLowerCase();
  if (payload.machine_ids && payload.machine_ids.length > 0) {
    const allowed = payload.machine_ids.map((m) => m.toLowerCase());
    if (!allowed.includes(currentMachineId)) {
      return result(false, "License not valid for this computer", payload);
    }
  } else if (payload.machine_id) {
    if (!validateMachineId(payload.machine_id, currentMachineId)) {
      return result(false, "License not valid for this computer", payload);
    }
  }

  return result(true, "", payload);
}

function hmacMatch(payloadB64: string, providedSignature: string, secret: string): boolean {
  try {
    const hmac = createHmac("sha256", secret);
    hmac.update(payloadB64, "utf8");
    const expected = Buffer.from(hmac.digest()).toString("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(providedSignature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Python's datetime.isoformat() output is UTC-naive with a 6-digit microsecond
// fraction (e.g. "2026-09-14T07:00:00.123456"). Node's Date parser needs a 'Z'
// to treat it as UTC, so append one. Returns null on unparseable input.
function parsePythonIsoformat(value: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}