import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_150 T5 — regression guard for lib/test-send-recipients.ts.
//
// WHY THIS FILE EXISTS: the campaign owner asked to "send a test to many test
// addresses at once, choosing all or a subset" (TASK_150 §3 T5). Every piece was
// already there — EmailCampaign.testRecipientPool, the add/remove UI, and a
// single active `testRecipientOverride` — but a test send could only ever target
// ONE address, and a request naming three went to the one stored address instead.
// Verified in simulation on a scratch DB 2026-09-30 against the pre-fix route
// (git show HEAD:app/api/campaigns/[id]/test-send/route.ts): posting
// { to: [alpha, bravo, charlie] } wrote ONE check row, for `alpha`.
//
// The assertions that actually matter are the ones a plausible refactor breaks:
//
//   1. An ARRAY must never fall through to the stored single target. That silent
//      fall-through is the reported bug: the owner asks for three inboxes and
//      three tests arrive in one.
//   2. A MISSING or EMPTY selection must behave exactly as before, or every
//      campaign that predates this column changes behaviour.
//   3. A malformed address inside a list must come back as an unusable RECIPIENT,
//      not a request-level error — the other addresses still have to be tested.
//
// The module under test has zero imports on purpose, so nothing needs stubbing;
// it is loaded with the house `require` pattern (HOW_WE_MOVE_FAST §4) because a
// bare `import ... from "../lib/test-send-recipients.ts"` fails `tsc` (the
// project does not enable `allowImportingTsExtensions`).

/* eslint-disable @typescript-eslint/no-require-imports */
const { planTestSendRecipients, normalizeRecipientList, MAX_TEST_SEND_RECIPIENTS } =
  require("../lib/test-send-recipients") as typeof import("../lib/test-send-recipients");
/* eslint-enable @typescript-eslint/no-require-imports */

const POOL = ["alpha@t5.test", "bravo@t5.test", "charlie@t5.test"];

test("a one-shot array fans out to EVERY address in it, not the stored single target", () => {
  const plan = planTestSendRecipients({ to: POOL, active: "stored@t5.test" });
  assert.equal(plan.mode, "override");
  assert.deepEqual(
    plan.mode === "override" ? plan.recipients.map((r) => r.email) : null,
    POOL,
  );
});

test("the persisted selection fans out when the request passes no `to`", () => {
  const plan = planTestSendRecipients({ selection: POOL, active: "stored@t5.test" });
  assert.equal(plan.mode, "override");
  assert.deepEqual(
    plan.mode === "override" ? plan.recipients.map((r) => r.email) : null,
    POOL,
  );
});

test("a subset selection sends to exactly the ticked addresses", () => {
  const plan = planTestSendRecipients({ selection: [POOL[2], POOL[0]], active: POOL[1] });
  assert.deepEqual(
    plan.mode === "override" ? plan.recipients.map((r) => r.email) : null,
    [POOL[2], POOL[0]],
  );
});

test("an explicit `to` outranks the stored selection (the caller's newest instruction wins)", () => {
  const plan = planTestSendRecipients({ to: POOL[1], selection: POOL });
  assert.deepEqual(
    plan.mode === "override" ? plan.recipients.map((r) => r.email) : null,
    [POOL[1]],
  );
});

test("a single string `to` still means exactly one address (back-compat)", () => {
  const plan = planTestSendRecipients({ to: POOL[0], active: "stored@t5.test" });
  assert.deepEqual(
    plan.mode === "override" ? plan.recipients.map((r) => r.email) : null,
    [POOL[0]],
  );
});

test("no `to`, an EMPTY selection and the single active target = today's behaviour", () => {
  const plan = planTestSendRecipients({ to: undefined, selection: [], active: POOL[1] });
  assert.deepEqual(
    plan.mode === "override" ? plan.recipients.map((r) => r.email) : null,
    [POOL[1]],
  );
});

test("an empty selection is 'not set', never 'send to nobody'", () => {
  const plan = planTestSendRecipients({ selection: [] });
  assert.equal(plan.mode, "seed");
});

test("with nothing set at all the seed-mailbox path is still used", () => {
  const plan = planTestSendRecipients({});
  assert.equal(plan.mode, "seed");
});

test("one malformed address in a list is a PER-ADDRESS failure, not a 400 for the whole request", () => {
  const plan = planTestSendRecipients({ to: [POOL[0], "not-an-address", POOL[2]] });
  assert.equal(plan.mode, "override");
  if (plan.mode !== "override") return;
  assert.deepEqual(
    plan.recipients.map((r) => [r.email, r.valid]),
    [
      [POOL[0], true],
      ["not-an-address", false],
      [POOL[2], true],
    ],
  );
});

test("an explicitly EMPTY array is an error, not a silent fall-through to the stored target", () => {
  const plan = planTestSendRecipients({ to: [], active: POOL[0] });
  assert.equal(plan.mode, "error");
  assert.equal(plan.mode === "error" ? plan.status : null, 400);
});

test("a non-string, non-array `to` is reported rather than ignored", () => {
  const plan = planTestSendRecipients({ to: 42, active: POOL[0] });
  assert.equal(plan.mode, "error");
});

test("normalisation trims, drops blanks, de-duplicates case-insensitively and keeps order", () => {
  assert.deepEqual(
    normalizeRecipientList(["  a@t5.test ", "", "A@T5.TEST", "b@t5.test", null, "  "]),
    ["a@t5.test", "b@t5.test"],
  );
});

test("normalisation clamps to the same cap the pool route enforces", () => {
  const many = Array.from({ length: MAX_TEST_SEND_RECIPIENTS + 5 }, (_, i) => `p${i}@t5.test`);
  assert.equal(normalizeRecipientList(many).length, MAX_TEST_SEND_RECIPIENTS);
});
