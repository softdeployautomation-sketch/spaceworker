// TASK_201 S13 — the "genuinely-purchased key says invalid" secret-drift fix.
//
// The mailer EXE validates a stored key OFFLINE using EXE_LICENSE_SECRET baked
// in at CI build time; a key bought/minted on the hosted site is signed with
// the PRODUCTION secret. When those drift, validateLicenseKey returns
// "Invalid license key signature" for a perfectly real key. The fix in
// app/api/exe-license/status/route.ts falls back to decodeLicenseKey (which
// needs NO signature) + a hosted eligibility check, instead of hard-failing.
//
// This test locks the two pure-library facts that fix depends on:
//   1. A key signed with a DIFFERENT secret still DECODES (payload readable,
//      signature NOT required) — so the fallback can read licensee/product/
//      expiry to make a hosted-server decision.
//   2. The same key is correctly REJECTED by validateLicenseKey under the wrong
//      secret — proving the drift is real and the fallback is necessary, not
//      masking a genuinely bad key.
// No server, no network, no filesystem: pure crypto via the real signers.
// generateLicenseKey reads the signing secret from EXE_LICENSE_SECRET (env), so
// we set it before the require (house pattern) and swap it per key to simulate
// issuer-vs-EXE secret drift. lib/exe-license.ts is "server-only", so we stub
// that module via a Module._load hook (same pattern as license-state-isolation).

import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    return original.call(this, request, parent, isMain);
  };
}
installRequireHook();

const ISSUER_SECRET = "production-signing-secret-abc123";
const EXE_BAKED_SECRET = "ci-build-time-secret-different-xyz";

// Set BEFORE importing the signer modules so exeLicenseSecret() sees it.
process.env.EXE_LICENSE_SECRET = ISSUER_SECRET;

/* eslint-disable @typescript-eslint/no-require-imports */
const { generateLicenseKey, decodeLicenseKey } = require("../lib/exe-license") as typeof import("../lib/exe-license");
const { validateLicenseKey } = require("../lib/exe-license-validator") as typeof import("../lib/exe-license-validator");
/* eslint-enable @typescript-eslint/no-require-imports */

function keySignedWith(secret: string) {
  process.env.EXE_LICENSE_SECRET = secret;
  try {
    return generateLicenseKey({
      licensee: "buyer@example.com",
      plan: "premium",
      product: "mailer_exe",
      machineId: "deadbeef",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
  } finally {
    process.env.EXE_LICENSE_SECRET = ISSUER_SECRET;
  }
}

test("a key signed with the production secret still DECODES under no signature check (the drift fallback needs this)", () => {
  const issued = keySignedWith(ISSUER_SECRET);

  // decodeLicenseKey never touches the signature — it just base64url-decodes
  // the payload. This is exactly what the status route's fallback uses.
  const decoded = decodeLicenseKey(issued.licenseKey);
  assert.ok(decoded, "payload must decode regardless of which secret signed it");
  assert.equal(decoded.licensee, "buyer@example.com");
  assert.equal(decoded.product, "mailer_exe");
  assert.equal(decoded.plan, "premium");
  assert.equal(decoded.machine_id, "deadbeef");
  assert.ok(decoded.expires_at, "expiry must be readable so the fallback can reject a truly-expired drifted key");
});

test("the SAME drifted key is correctly rejected by validateLicenseKey under the wrong (EXE-baked) secret — proving the fallback is necessary", async () => {
  const issued = keySignedWith(ISSUER_SECRET);

  // Under the correct (production) secret it validates:
  const good = await validateLicenseKey(issued.licenseKey, ISSUER_SECRET, {
    currentMachineId: "deadbeef",
  });
  assert.equal(good.valid, true, "key must validate under its own signing secret");

  // Under the drifted (EXE-baked) secret it fails signature — the exact bug.
  const drifted = await validateLicenseKey(issued.licenseKey, EXE_BAKED_SECRET, {
    currentMachineId: "deadbeef",
  });
  assert.equal(drifted.valid, false);
  assert.match(drifted.error, /signature/i, "the failure mode the user saw: an offline signature mismatch");

  // ...and yet decodeLicenseKey still reads it (the fallback's escape hatch).
  const stillReadable = decodeLicenseKey(issued.licenseKey);
  assert.ok(stillReadable, "drifted-but-real key must remain decodable so the hosted check can rescue it");
});
