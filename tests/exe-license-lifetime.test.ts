import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync } from "node:fs";

// TASK_145 T17 — the lifetime sentinel's contract, pinned in a permanent test.
//
// WHY THIS FILE EXISTS: T3 added three constants to lib/exe-license.ts (`:29-40`)
// that decide whether a licence is a "lifetime" grant — a frozen Python-isoformat
// literal, the matching `Date`, and `isLifetimeExpiry`'s year threshold. `2999`
// is therefore value-coupled across three lines (senior finding `W12`): change
// the threshold without changing the signed literal and EVERY lifetime licence
// silently misclassifies as a term licence — the admin-move lock (D9) and the
// "no renewal needed" copy both stop applying, with no error anywhere in the app.
// T3's only proof was a temporary `/tmp` harness that was deleted after the run,
// so `S2`/`S3` were closed on evidence the next agent cannot re-run (senior
// §3.12.2, new rule §4.1b). This file is that check's permanent home: it replaces
// the ephemeral evidence AND is the guard that makes the triplicated `2999` safe
// WITHOUT editing the frozen lib (the ISO literal is hashed into the signature,
// so it can never be recomputed).
//
// HOW: every key below is minted and validated through the REAL
// `generateLicenseKey` / `validateLicenseKey` (lib/exe-license.ts +
// lib/exe-license-validator.ts) — no hand-built payloads, no mocks, no HMAC
// bypass. "lifetime" is decided ONLY from the decoded `expires_at`, never a
// client flag, a DB column, or `daysValid` arithmetic.
//
// WHAT THIS CANNOT PROVE (said plainly): that the shipped desktop EXE's own
// Python `validator.py` classifies a 2999 key the same way. That check lives on
// the Python side (lead-extractor), not here.
//
// `lib/exe-license.ts:1` / `lib/exe-license-validator.ts:1` are
// `import "server-only"`, which throws in a plain Node process, so the house
// `Module._load` hook (same pattern as tests/self-hosted-setup.test.ts and the
// ready-made scripts/stub-server-only.cjs) neutralises that marker. No database,
// no network, no `.env.local`: the key is not DB-validated, so
// `licensee`/`plan`/`product` are arbitrary strings and T2's product registry is
// deliberately not consulted.

// Must be set BEFORE the module is required — generateLicenseKey reads it at
// call time, but the env is established first so nothing can depend on ordering.
process.env.EXE_LICENSE_SECRET = "task145-t17-lifetime-contract-secret";
// Defensive only: keep any local licence-state file inside a throwaway dir. Every
// validate* call below also passes an explicit `currentMachineId`, so
// getCachedMachineId() is never reached and no real state is read or written.
process.env.SPACEWORKER_LOCAL_DATA_DIR = mkdtempSync(
  `${process.env.TMPDIR ?? "/tmp"}/task145-t17-`,
);

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    // `server-only` is a marker package whose non-RSC entry throws by design.
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const license = require("../lib/exe-license") as typeof import("../lib/exe-license");
const validator = require("../lib/exe-license-validator") as typeof import("../lib/exe-license-validator");
/* eslint-enable @typescript-eslint/no-require-imports */

const {
  LIFETIME_EXPIRES_AT,
  LIFETIME_EXPIRES_AT_ISO,
  isLifetimeExpiry,
  generateLicenseKey,
  verifyLicenseKey,
  decodeLicenseKey,
} = license;
const { validateLicenseKey } = validator;

const SECRET = process.env.EXE_LICENSE_SECRET;
assert.ok(SECRET, "the test secret must be set before the module is loaded");

// Arbitrary strings on purpose: this test must not depend on T2's product
// registry, and the key is never DB-validated on this path.
const ARBITRARY = {
  licensee: "t17-buyer@example.test",
  plan: "selfhosted",
  product: "selfhosted_os",
} as const;

// No key in this file is machine-bound, so this value is never compared — it is
// passed only so the validator never calls getCachedMachineId().
const CURRENT_MACHINE = "task145-t17-unbound-machine";

/** Mints a lifetime key through the REAL generator (never a hand-built payload). */
function mintLifetimeKey() {
  return generateLicenseKey({ ...ARBITRARY, expiresAt: LIFETIME_EXPIRES_AT });
}

test("1. LIFETIME_EXPIRES_AT_ISO is the frozen Python-isoformat literal, with no trailing 'Z'", () => {
  assert.equal(LIFETIME_EXPIRES_AT_ISO, "2999-12-31T23:59:59.000000");
  // Python's datetime.fromisoformat() only accepted a trailing 'Z' from 3.11;
  // the sentinel must stay parseable on every version (lib/exe-license.ts:76-85).
  assert.equal(LIFETIME_EXPIRES_AT_ISO.endsWith("Z"), false);
});

test("2. LIFETIME_EXPIRES_AT is the same instant, and its .000000 micros are lossless", () => {
  assert.equal(LIFETIME_EXPIRES_AT.toISOString(), "2999-12-31T23:59:59.000Z");
  assert.equal(LIFETIME_EXPIRES_AT.getUTCMilliseconds(), 0);
  // The two exports must agree, or a key signed with one would not decode to the
  // other's literal year.
  assert.equal(LIFETIME_EXPIRES_AT.getUTCFullYear(), 2999);
});

test("3. DRIFT GUARD — a key signed at the sentinel emits LIFETIME_EXPIRES_AT_ISO byte-for-byte", () => {
  const issued = mintLifetimeKey();
  // D4 rests on this: the sentinel is signed, so it can never be recomputed.
  assert.equal(issued.payload.expires_at, LIFETIME_EXPIRES_AT_ISO);
  assert.equal(issued.expiresAt.getTime(), LIFETIME_EXPIRES_AT.getTime());
  // ...and the signature is real (re-derived HMAC), not a stub.
  assert.equal(verifyLicenseKey(issued.licenseKey), true);
  assert.equal(decodeLicenseKey(issued.licenseKey)?.expires_at, LIFETIME_EXPIRES_AT_ISO);
});

test("4. the real offline validator accepts the lifetime key today, decoded year 2999", async () => {
  const issued = mintLifetimeKey();
  // `now` omitted on purpose — this is literally "today's clock".
  const res = await validateLicenseKey(issued.licenseKey, SECRET, {
    currentMachineId: CURRENT_MACHINE,
  });
  assert.equal(res.valid, true, res.error);
  assert.equal(res.expiresAt, LIFETIME_EXPIRES_AT_ISO);
  assert.equal(res.expiresAtDate?.getUTCFullYear(), 2999);
});

test("5. the sentinel is still valid in 2050, 2099 and 2998 — not an accident of today's clock", async () => {
  const issued = mintLifetimeKey();
  for (const year of [2050, 2099, 2998]) {
    const res = await validateLicenseKey(issued.licenseKey, SECRET, {
      currentMachineId: CURRENT_MACHINE,
      now: new Date(Date.UTC(year, 0, 1)),
    });
    assert.equal(res.valid, true, `${year}: ${res.error}`);
  }
});

test("6. the sentinel terminates in 3000 — it is not truly perpetual", async () => {
  const issued = mintLifetimeKey();
  const res = await validateLicenseKey(issued.licenseKey, SECRET, {
    currentMachineId: CURRENT_MACHINE,
    now: new Date(Date.UTC(3000, 0, 1)),
  });
  assert.equal(res.valid, false, "a year-3000 clock must see the licence as expired");
  assert.match(res.error, /expired/i);
});

test("7. isLifetimeExpiry is driven only by the expiry year", () => {
  assert.equal(isLifetimeExpiry(LIFETIME_EXPIRES_AT), true);
  assert.equal(isLifetimeExpiry(null), false);
  assert.equal(isLifetimeExpiry(undefined), false);
  assert.equal(isLifetimeExpiry(new Date("2998-12-31T23:59:59Z")), false);
});

test("8. CRITICAL NEGATIVE — a 30-day term key is never classified lifetime, and dies on time", async () => {
  const issued = generateLicenseKey({
    ...ARBITRARY,
    daysValid: 30,
    at: new Date("2026-01-01T00:00:00Z"),
  });
  assert.ok(
    issued.payload.expires_at.startsWith("2026-01-31"),
    `expected a 30-day expiry in January 2026, got ${issued.payload.expires_at}`,
  );
  // If this were misclassified lifetime, the owner's "immediate revocation" half
  // would silently stop applying to term licences.
  assert.equal(isLifetimeExpiry(issued.expiresAt), false);

  const day29 = await validateLicenseKey(issued.licenseKey, SECRET, {
    currentMachineId: CURRENT_MACHINE,
    now: new Date(Date.UTC(2026, 0, 30)),
  });
  assert.equal(day29.valid, true, day29.error);
  assert.equal(isLifetimeExpiry(day29.expiresAtDate), false);

  const day31 = await validateLicenseKey(issued.licenseKey, SECRET, {
    currentMachineId: CURRENT_MACHINE,
    now: new Date(Date.UTC(2026, 1, 1)),
  });
  assert.equal(day31.valid, false, "a term key must be expired the day after it lapses");
  assert.match(day31.error, /expired/i);
});

test("9. every key here goes through the REAL HMAC — tampering and a wrong secret both fail", async () => {
  const issued = mintLifetimeKey();
  assert.equal(verifyLicenseKey(issued.licenseKey), true);

  // A single changed payload character must break the signature. If this still
  // verified, facts 3-8 would be meaningless (a bypassed HMAC).
  const [payloadB64, signature] = issued.licenseKey.split(".");
  const tampered = `${payloadB64.slice(0, -1)}X.${signature}`;
  assert.equal(verifyLicenseKey(tampered), false);

  const wrongSecret = await validateLicenseKey(issued.licenseKey, "not-the-signing-secret", {
    currentMachineId: CURRENT_MACHINE,
  });
  assert.equal(wrongSecret.valid, false);
  assert.match(wrongSecret.error, /signature/i);
});

