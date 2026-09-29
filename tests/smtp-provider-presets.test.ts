import { test } from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_PRESETS, presetForHost, type PresetSecurityMode } from "../lib/smtp-provider-presets";

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
//   2. An "unencrypted" preset. That mode is the exact combination behind the
//      original incident: a relay advertising no AUTH accepts the message and drops
//      it while every connection test looks green. Every commercial provider offers
//      TLS, so offering "unencrypted" for one would only invite that bug back. The
//      single exemption is the `internal` entry for the relay this platform runs on
//      its own machine — loopback-only, so nothing off-box can reach it — and the
//      tests below pin that the exemption stays exactly one entry wide.
//
//   3. A fabricated username. Only providers that mandate a literal login
//      (Resend needs "resend", SendGrid needs "apikey") may set fixedUser;
//      everywhere else the login is the user's own address and inventing one
//      would guarantee an auth failure.

/**
 * The handshake the SEND actually negotiates for a (mode, port) pair.
 *
 * Mirrors the real rule rather than a simplification of it: effectiveMode() in
 * components/mailboxes-panel.tsx and lib/mailer-send.ts both force implicit TLS on
 * port 465, and both honour "none" as an explicit opt-out on any other port. A test
 * that modelled only "465 => implicit, else STARTTLS" would wrongly reject the
 * loopback relay preset (587 + none), which is a correct combination for a
 * loopback-only relay — while still catching the case this exists for, a provider
 * labelled STARTTLS on 465.
 */
function handshakeTheSendPathUses(mode: PresetSecurityMode, port: number): PresetSecurityMode {
  if (port === 465) return "implicit";
  return mode === "none" ? "none" : "starttls";
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

test("no COMMERCIAL preset uses the unencrypted mode (the accept-and-drop incident)", () => {
  // See the file header: "none" is for a loopback-only relay, never for a provider.
  const insecure = PROVIDER_PRESETS.filter((p) => !p.internal && p.securityMode === "none").map(
    (p) => p.id,
  );
  assert.deepEqual(insecure, [], `these presets offer unencrypted sending: ${insecure.join(", ")}`);
});

test("the unencrypted exemption is exactly one entry, and it is loopback-only", () => {
  // The exemption is a hole in the rule above, so its WIDTH is the thing to pin:
  // an "internal" commercial endpoint would let the accept-and-drop bug back in
  // under a name that sounds safe.
  const internal = PROVIDER_PRESETS.filter((p) => p.internal);
  assert.deepEqual(
    internal.map((p) => p.id),
    ["relay"],
    "internal presets must stay a single, known entry — add one deliberately, not by accident",
  );
  for (const p of internal) {
    assert.equal(p.securityMode, "none", `${p.id}: an internal relay is the only place "none" is right`);
    assert.ok(
      ["127.0.0.1", "::1", "localhost"].includes(p.host),
      `${p.id}: an internal preset must be loopback-only, got ${p.host}`,
    );
  }
});

test("every preset's port agrees with the handshake it promises", () => {
  // This is the assertion that actually matters — see the file header.
  for (const p of PROVIDER_PRESETS) {
    const port = Number(p.port);
    const negotiated = handshakeTheSendPathUses(p.securityMode, port);
    assert.equal(
      p.securityMode,
      negotiated,
      `${p.id}: preset says "${p.securityMode}" but port ${p.port} makes the send path negotiate "${negotiated}"`,
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

test("the submission-port story is not 465-only (the 2026-09-29 WEDOS incident)", () => {
  // WHAT WENT WRONG: a customer's WEDOS mailbox sent fine — Gammadyne reached a
  // Comcast inbox and our OWN transport reached it in 789ms — yet the app told them
  // the server "did not ask for a username or password at all". That verdict came
  // from OUR probe reading AUTH off the PLAINTEXT EHLO (fixed in
  // lib/smtp-diagnostics.ts). Nothing about the mailbox was wrong.
  //
  // The preset gap this pins is smaller but real: the only shared-hosting entry
  // offered 465 + implicit, so the shape that actually worked — 587 + STARTTLS —
  // had no preset at all and had to be hand-typed. Both are now present.
  const wedos = PROVIDER_PRESETS.find((p) => p.id === "wedos");
  assert.ok(wedos, "the WEDOS entry is the regression for this incident");
  assert.equal(wedos.port, "587");
  assert.equal(wedos.securityMode, "starttls");
  // WEDOS authenticates the mailbox's own address, so a literal login here would
  // guarantee an auth failure — the exact trap the fixedUser rule exists to stop.
  assert.equal(wedos.fixedUser, undefined);
  // The generic entry must not be a second name for the WEDOS host, or the picker
  // would claim a specific provider for someone else's server.
  const generic = PROVIDER_PRESETS.find((p) => p.id === "submission587");
  assert.ok(generic, "a generic 587 + STARTTLS entry must exist for unlisted providers");
  assert.equal(generic.port, "587");
  assert.equal(generic.securityMode, "starttls");
  assert.notEqual(generic.host, wedos.host);

  // And the property that made 465-only a gap: a 587 STARTTLS preset exists.
  const starttls587 = PROVIDER_PRESETS.filter((p) => p.port === "587" && p.securityMode === "starttls");
  assert.ok(starttls587.length >= 2, "expected several 587 + STARTTLS entries");
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
  // The loopback relay IS ours, so it matches its own preset — this is the one host
  // that was deliberately added to the table...
  assert.equal(presetForHost("127.0.0.1")?.id, "relay");
  // ...while an unrelated private address must still match nothing, or the label
  // would claim some other internal server is this platform's relay.
  assert.equal(presetForHost("10.0.0.5"), null);
  assert.equal(presetForHost(""), null);
  assert.equal(presetForHost("   "), null);
});
