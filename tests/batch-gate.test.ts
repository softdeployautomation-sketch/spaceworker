import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_150 T3 — regression guard for lib/batch-gate-decision.ts.
//
// WHY THIS FILE EXISTS: the batch gate used to reduce to one predicate,
// `probe.landedIn === "inbox"`, and treat everything else as a FAILED check. In
// human-assisted mode (EmailCampaign.testRecipientOverride) lib/deliverability.ts
// pins landedIn to "unknown" BY DESIGN — there is no IMAP account watching an
// arbitrary human inbox — so that predicate was false on every single batch and
// each boundary was reported to the user as a failed deliverability check, even
// though the test send itself succeeded. The user had explicitly chosen "use my
// test email" and was told, every batch, that the check could not be verified.
//
// The invariant that has to hold, and that a plausible refactor would break:
//
//   A batch boundary in override mode is the owner's TURN, never a FAILURE.
//
// So "override + landedIn unknown" must resolve to human_confirm and must NOT
// resolve to pause_failed. landedIn is asserted to be IRRELEVANT in that mode
// (including the impossible "inbox"/"spam" values) — that is what proves the
// decision cannot silently drift back to a placement verdict.
//
// The module under test has zero imports on purpose, so there is nothing to stub
// and it is loaded with the house `require` pattern (HOW_WE_MOVE_FAST §4) — a
// bare `import ... from "../lib/batch-gate-decision.ts"` fails `tsc` because the
// project does not enable `allowImportingTsExtensions`.

/* eslint-disable @typescript-eslint/no-require-imports */
const { decideBatchGate } = require("../lib/batch-gate-decision") as typeof import("../lib/batch-gate-decision");
/* eslint-enable @typescript-eslint/no-require-imports */

test("manual mode at a batch boundary is human-confirm, NEVER a failed check", () => {
  const d = decideBatchGate({ overrideRecipient: "owner@example.com", landedIn: "unknown" });
  assert.equal(d.action, "human_confirm");
  assert.notEqual(d.action, "pause_failed");
  assert.equal(d.mode, "manual");
  assert.equal(d.action === "human_confirm" ? d.recipient : null, "owner@example.com");
});

test("manual mode ignores landedIn entirely (even placement values it can never produce)", () => {
  for (const landedIn of ["unknown", "spam", "inbox"] as const) {
    const d = decideBatchGate({ overrideRecipient: "owner@example.com", landedIn });
    assert.equal(d.action, "human_confirm", `landedIn=${landedIn} must still be a human-confirm turn`);
  }
});

test("a whitespace-wrapped override is still manual, and the copy gets the trimmed address", () => {
  const d = decideBatchGate({ overrideRecipient: "  owner@example.com  ", landedIn: "unknown" });
  assert.equal(d.action, "human_confirm");
  assert.equal(d.action === "human_confirm" ? d.recipient : null, "owner@example.com");
});

test("a cleared/blank override falls back to the automated path (never a hidden manual gate)", () => {
  assert.equal(decideBatchGate({ overrideRecipient: "", landedIn: "inbox" }).action, "continue");
  assert.equal(decideBatchGate({ overrideRecipient: "   ", landedIn: "inbox" }).action, "continue");
  assert.equal(decideBatchGate({ overrideRecipient: null, landedIn: "inbox" }).action, "continue");
  assert.equal(decideBatchGate({ landedIn: "inbox" }).action, "continue");
});

test("automated mode unchanged: inbox continues, spam/unknown really did fail", () => {
  assert.equal(decideBatchGate({ landedIn: "inbox" }).action, "continue");
  const spam = decideBatchGate({ landedIn: "spam" });
  assert.equal(spam.action, "pause_failed");
  assert.equal(spam.action === "pause_failed" ? spam.landedIn : null, "spam");
  const unknown = decideBatchGate({ landedIn: "unknown" });
  assert.equal(unknown.action, "pause_failed");
  assert.equal(unknown.action === "pause_failed" ? unknown.landedIn : null, "unknown");
  // ...and the auto path is never labelled manual.
  assert.equal(decideBatchGate({ landedIn: "unknown" }).mode, "auto");
});

test("regression: the OLD predicate classified manual mode as a failed check (the shipped bug)", () => {
  // The pre-TASK_150 rule, verbatim. Keeping it here as a witness is the point:
  // this assertion shows the failure mode is real and that the new decision is
  // not merely a re-spelling of it.
  const legacySafe = (landedIn: string) => landedIn === "inbox";
  assert.equal(legacySafe("unknown"), false); // ...always, in manual mode
  assert.notEqual(
    decideBatchGate({ overrideRecipient: "owner@example.com", landedIn: "unknown" }).action,
    legacySafe("unknown") ? "continue" : "pause_failed",
  );
});
