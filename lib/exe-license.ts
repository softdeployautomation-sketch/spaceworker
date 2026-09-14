import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

// Task 42, item 4 — the exact license-key scheme Lead Extractor Pro already
// ships (`~/lead-extractor/app/license/generator.py`), ported byte-for-byte so
// a key issued by SpaceWorker today validates identically inside the real EXE
// once Task 27 Part A builds its validator — zero reissuance needed.
//
//   payload   = { licensee, plan, issued_at, expires_at }   (no machine binding
//               server-side at issuance time — that happens client-side inside
//               the EXE at first activation, per Part A)
//   payload_json = JSON.stringify(payload) with keys sorted ALPHABETICALLY.
//                  Python's json.dumps(sort_keys=True) emits a space after the
//                  colon and after each comma; Node's JSON.stringify does not,
//                  so we hand-roll an exact-match serializer below.
//   payload_b64  = base64url(payload_json)
//   signature    = hex( HMAC-SHA256(secret, payload_b64) )
//   license_key  = `${payload_b64}.${signature}`

// The duration of every EXE license. Decided 2026-09-14: a real 6-month term,
// NOT perpetual. Deliberately NOT shown on the public store page — it's first
// disclosed to the buyer on the post-purchase license page/email (item 4/6).
export const EXE_LICENSE_DAYS = 180;

const BASE64URL_RE = /^[A-Za-z0-9_-]+=*$/;

/**
 * Reads the EXE-license signing secret. This is its own required-in-prod env var
 * (EXE_LICENSE_SECRET) — never reuse INTERNAL_BEARER_TOKEN or any other existing
 * secret, because a leaked key-signing secret can forge unlimited licenses.
 *
 * Fail-CLOSED rather than required(): the app still builds and boots for a local
 * build without it (mirroring ADMIN_TOKEN's discipline), but issuing a license
 * throws at runtime until it's set, so a production deploy can't silently mint
 * unverifiable keys.
 */
export function exeLicenseSecret(): string {
  const secret = process.env.EXE_LICENSE_SECRET ?? "";
  if (secret.trim().length === 0) {
    throw new Error(
      "EXE_LICENSE_SECRET is not configured — cannot sign EXE licenses. Set it in the environment before approving any EXE payment.",
    );
  }
  return secret;
}

// Python's json.dumps(sort_keys=True) with default separators (", ", ": "), for
// the flat string-valued payloads this scheme produces. Produces:
//   {"expires_at": "...", "issued_at": "...", "licensee": "x", "plan": "pro"}
// (no padding spaces after the outer braces, ", " between pairs, ": " between
// key and value) — byte-identical to what generator.py base64-encodes.
function pyJsonDumpsSorted(obj: LicensePayload): string {
  const rec = obj as unknown as Record<string, string>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(rec[k])}`);
  return `{${parts.join(", ")}}`;
}

// Matches Python's `datetime.utcnow().isoformat()` EXACTLY — no 'Z' suffix, no
// timezone offset, 6-digit microsecond fraction (Python's isoformat drops the
// fraction entirely when it's exactly zero, but a real timestamp's is never
// zero in practice, so the fixed 6-digit form is what generator.py actually
// emits). This matters beyond byte-matching the signature: the real EXE's
// validator.py calls `datetime.fromisoformat(payload["expires_at"])`, which
// only started accepting a trailing 'Z' in Python 3.11 — a plain
// `Date.toISOString()` value (which always ends in 'Z') would raise
// ValueError and make every issued license appear invalid on Python <3.11.
// Reproducing Python's own isoformat() output is parseable on every version.
function toPythonIsoformat(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  const micro = pad(d.getUTCMilliseconds() * 1000, 6);
  return `${y}-${mo}-${day}T${h}:${mi}:${s}.${micro}`;
}

function sign(payloadB64: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(payloadB64, "utf8");
  // Node 15+'s crypto hash digest is a Uint8Array — hex-string it explicitly.
  return Buffer.from(hmac.digest()).toString("hex");
}

export interface GenerateLicenseKeyInput {
  licensee: string; // the buyer's email — embedded as `licensee` per Part A
  plan: string; // the purchased EXE tier's slug (Product.plan)
  daysValid?: number; // defaults to EXE_LICENSE_DAYS (180)
  at?: Date; // test seam: override "now" for deterministic keys
}

export interface IssuedLicense {
  licenseKey: string;
  payload: LicensePayload;
  issuedAt: Date;
  expiresAt: Date;
}

export interface LicensePayload {
  licensee: string;
  plan: string;
  issued_at: string;
  expires_at: string;
}

/**
 * Generates a signed license key in the Lead Extractor Pro format. Returns the
 * full key plus the decoded payload / dates so callers (lib/license-service.ts)
 * can surface the real 6-month expiry without decoding it back.
 */
export function generateLicenseKey(input: GenerateLicenseKeyInput): IssuedLicense {
  const secret = exeLicenseSecret();
  const daysValid = input.daysValid ?? EXE_LICENSE_DAYS;
  const now = input.at ?? new Date();

  const issuedAt = now;
  const expiresAt = new Date(now.getTime() + daysValid * 24 * 60 * 60 * 1000);

  const payload: LicensePayload = {
    licensee: String(input.licensee),
    plan: String(input.plan),
    issued_at: toPythonIsoformat(issuedAt),
    expires_at: toPythonIsoformat(expiresAt),
  };

  const payloadJson = pyJsonDumpsSorted(payload);
  const payloadB64 = b64urlEncode(payloadJson);
  const signature = sign(payloadB64, secret);

  return {
    licenseKey: `${payloadB64}.${signature}`,
    payload,
    issuedAt,
    expiresAt,
  };
}

/** Decodes the base64url payload of a key WITHOUT verifying its signature. */
export function decodeLicenseKey(licenseKey: string): LicensePayload | null {
  const parts = licenseKey.trim().split(".");
  if (parts.length !== 2 || !BASE64URL_RE.test(parts[0])) return null;
  try {
    return JSON.parse(b64urlDecode(parts[0]));
  } catch {
    return null;
  }
}

/**
 * Re-derives the HMAC over the key's payload and constant-time-compares it to
 * the key's own signature. Returns true only for a genuinely valid key under the
 * configured secret — the ported validator's exact check.
 */
export function verifyLicenseKey(licenseKey: string): boolean {
  const parts = licenseKey.trim().split(".");
  if (parts.length !== 2) return false;
  const [payloadB64, signature] = parts;
  if (!BASE64URL_RE.test(payloadB64) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  try {
    const expected = sign(payloadB64, exeLicenseSecret());
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function b64urlEncode(text: string): string {
  // Python's base64.urlsafe_b64encode always includes '=' padding; Node's
  // Buffer#toString('base64url') strips it. The signature covers the exact
  // stored base64url string, so we must match Python's padded form byte-for-byte
  // or the real EXE's validator (which re-HMACs the padded stored string) would
  // reject every key we issue.
  let encoded = Buffer.from(text, "utf8").toString("base64url");
  const remainder = encoded.length % 4;
  if (remainder !== 0) encoded += "=".repeat(4 - remainder);
  return encoded;
}

function b64urlDecode(text: string): string {
  return Buffer.from(text, "base64url").toString("utf8");
}