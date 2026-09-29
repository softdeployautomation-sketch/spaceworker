import { test } from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_PRESETS, presetForHost } from "../lib/smtp-provider-presets";

// Regression test for the provider quick-fill presets.
//
// WHY THIS FILE EXISTS: a preset's entire value is that it sets host + port +
// security TOGETHER. A preset carrying the right host but the wrong port is
// worse than no preset at all — it looks authoritative while producing a
// connection the provider will never answer, and the user experiences it as the
// "Test connection sits on Testing… for two minutes" hang this codebase has
// already been burned by. Nothing in the UI can catch that; only this test can.
//
// The three properties pinned here are the three ways a preset can silently
// break a mailbox:
//
//   1. Port/security disagreement. The send path derives the handshake from the
//      PORT (lib/mailer-send.ts: 465 => implicit TLS, anything else => STARTTLS),
//      NOT from the label. So a preset labelled "implicit" on 587, or
//      "STARTTLS" on 465, sends the user into a handshake the provider rejects.
//
//   2. An "unencrypted" preset. That mode exists only for self-hosted/internal
//      relays and is the exact combination behind the original incident: a relay
//      advertising no AUTH accepts the message and drops it while every
//      connection test looks green. Every commercial provider offers TLS, so
//      offering "unencrypted" for one would only invite that bug back.
//
//   3. A fabricated username. Only providers that mandate a literal login
//      (Resend needs "resend", SendGrid needs "apikey") may set fixedUser;
//      everywhere else the login is the user's own address and inventing one
//      would guarantee an auth failure.

/** The send path reads the handshake from the port, not the label — mirror it. */
function handshakeImpliedByPort(port: number): "implicit" | "starttls" {
  return port === 465 ? "implicit" : "starttls";
}

test("every preset is complete and internally consistent", () => {
  assert.ok(PROVIDER_PRESETS.length >= 8, "expected a useful spread of providers");

  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.id.length > 0, `${p.label}: id must not be empty`);
    assert.ok(p.label.length > 0, `${p.id}: label must not be empty`);
    assert.ok(p.host.length > 0, `${p.id}: host must not be empty`);
    assert.ok(p.note.length > 0, `${p.id}: note must not be empty (the login convention is not guessable)`);
    assert.match(p.port, /^\d+$/, `${p.id}: port must be a numeric string, got ${JSON.stringify(p.port)}`);
  }
});

test("preset ids are unique", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate preset id in ${ids.join(",")}`);
});

test("no preset uses the unencrypted mode (the accept-and-drop incident)", () => {
  // See the file header: "none" is for self-hosted relays only.
  const insecure = PROVIDER_PRESETS.filter((p) => p.securityMode === "none").map((p) => p.id);
  assert.deepEqual(insecure, [], `these presets offer unencrypted sending: ${insecure.join(", ")}`);
});

test("every preset's port agrees with the handshake it promises", () => {
  // This is the assertion that actually matters — see the file header.
  for (const p of PROVIDER_PRESETS) {
    const implied = handshakeImpliedByPort(Number(p.port));
    assert.equal(
      p.securityMode,
      implied,
      `${p.id}: preset says "${p.securityMode}" but port ${p.port} makes the send path negotiate "${implied}"`,
    );
  }
});

test("only providers that require a literal login set fixedUser", () => {
  // Anything with an "@" here would be a fabricated address, not a protocol login.
  const REQUIRES_LITERAL_LOGIN = new Set(["resend", "sendgrid"]);
  for (const p of PROVIDER_PRESETS) {
    if (p.fixedUser !== undefined) {
      assert.ok(
        REQUIRES_LITERAL_LOGIN.has(p.id),
        `${p.id}: sets fixedUser but is not a provider that mandates a literal login`,
      );
      assert.ok(!p.fixedUser.includes("@"), `${p.id}: fixedUser must be a protocol login, not an address`);
      assert.ok(p.fixedUser.length > 0, `${p.id}: fixedUser must not be empty`);
    }
  }
});

test("presetForHost recognises a saved host, and nothing else", () => {
  for (const p of PROVIDER_PRESETS) {
    assert.equal(presetForHost(p.host)?.id, p.id, `${p.host} should map to ${p.id}`);
  }
  // Saved values are user input: case and stray whitespace must not defeat it...
  assert.equal(presetForHost("  SMTP.RESEND.COM  ")?.id, "resend");
  // ...but a self-hosted/custom endpoint must match NOTHING, or the form would
  // label someone else's server with a provider's login convention.
  assert.equal(presetForHost("watsonandrade9382.ca.lu"), null);
  assert.equal(presetForHost("127.0.0.1"), null);
  assert.equal(presetForHost(""), null);
  assert.equal(presetForHost("   "), null);
});
