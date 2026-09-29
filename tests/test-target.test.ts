import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_143 — regression guard for lib/test-target.ts.
//
// WHY THIS FILE EXISTS: this rule is four lines long, but the bug it fixes was
// invisible in the UI. The only way to set a deliverability test target used to
// be the `manualInsert.useAsTestTarget` flag, and using it ALSO queued that
// address as a real recipient — so "test in my own inbox" silently meant "and
// send me the campaign too". Confirmed live 2026-09-29: one address received 4
// tests plus 3 queue sends within four minutes, all identical.
//
// The two assertions that actually matter here are the ones a plausible
// refactor would break:
//
//   1. A STANDALONE target must survive without any manualInsert at all — that
//      is the whole feature (test without becoming a recipient).
//   2. When BOTH inputs arrive, the standalone field must win. Preferring the
//      legacy nested flag would send tests to an address the user never typed
//      into the new field, which is worse than either behaviour alone.
//
// The module under test has zero imports on purpose, so there is nothing to stub
// and it is loaded with the house `require` pattern (HOW_WE_MOVE_FAST §4) — a
// bare `import ... from "../lib/test-target.ts"` fails `tsc` because the project
// does not enable `allowImportingTsExtensions`.

/* eslint-disable @typescript-eslint/no-require-imports */
const { resolveTestTarget } = require("../lib/test-target") as typeof import("../lib/test-target");
/* eslint-enable @typescript-eslint/no-require-imports */

test("standalone target is honoured with no queue insert at all", () => {
  const r = resolveTestTarget({ standalone: "typple6@comcast.net" });
  assert.equal(r.testRecipientOverride, "typple6@comcast.net");
  assert.equal(r.error, undefined);
});

test("standalone target is trimmed, and surrounding space does not survive into the envelope", () => {
  const r = resolveTestTarget({ standalone: "  typple6@comcast.net  " });
  assert.equal(r.testRecipientOverride, "typple6@comcast.net");
});

test("standalone WINS when the legacy opt-in flag is also present (they must never disagree)", () => {
  const r = resolveTestTarget({
    standalone: "new@example.com",
    manualInsertEmail: "old@example.com",
    manualInsertUseAsTestTarget: true,
  });
  assert.equal(r.testRecipientOverride, "new@example.com");
});

test("legacy nested flag still works on its own (backward compatibility)", () => {
  const r = resolveTestTarget({
    manualInsertEmail: "legacy@example.com",
    manualInsertUseAsTestTarget: true,
  });
  assert.equal(r.testRecipientOverride, "legacy@example.com");
});

test("a queued manual insert that did NOT opt in is never made the test target", () => {
  // This is the regression itself: inserting a recipient must not move tests.
  const r = resolveTestTarget({
    manualInsertEmail: "recipient@example.com",
    manualInsertUseAsTestTarget: false,
  });
  assert.equal(r.testRecipientOverride, null);
  assert.equal(r.error, undefined);
});

test("no target configured means automation, not a broken mailbox", () => {
  const r = resolveTestTarget({});
  assert.equal(r.testRecipientOverride, null);
  assert.equal(r.error, undefined, "omitting a target is valid — the seed mailbox path is used");
});

test("a malformed standalone target is rejected with an error, not stored", () => {
  for (const bad of ["you@", "you@example", "not-an-email", "@example.com", "a b@example.com"]) {
    const r = resolveTestTarget({ standalone: bad });
    assert.equal(r.testRecipientOverride, null, `${bad} must not be stored`);
    assert.equal(r.error, "Enter a valid test email address");
  }
});

test("a malformed LEGACY target is rejected too (it previously had no validation at all)", () => {
  const r = resolveTestTarget({
    manualInsertEmail: "you@",
    manualInsertUseAsTestTarget: true,
  });
  assert.equal(r.testRecipientOverride, null);
  assert.equal(r.error, "Enter a valid test email address");
});

test("a valid address with a subdomain and plus-tag passes", () => {
  const r = resolveTestTarget({ standalone: "first.last+tag@mail.example.co.uk" });
  assert.equal(r.testRecipientOverride, "first.last+tag@mail.example.co.uk");
});

test("whitespace-only input is treated as absent, not as an error", () => {
  const r = resolveTestTarget({ standalone: "   " });
  assert.equal(r.testRecipientOverride, null);
  assert.equal(r.error, undefined);
});
