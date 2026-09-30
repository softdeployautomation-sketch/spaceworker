import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_150 T2 — regression guard for the cross-session duplicate rule.
//
// WHY THIS FILE EXISTS: the reported symptom is "the extractor returns the same
// emails every session, and Validate emails does not remove repeats from
// previous sessions". The database cause is that Lead's uniqueness is PER JOB
// (@@unique([searchJobId, sourceUrl, email])), so two sessions are two
// SearchJobs and the same address is legitimately stored twice. Every rule that
// decides WHICH row is the repeat is invisible in the UI — all the owner sees is
// a pill and a count — so this file pins the rule itself.
//
// The two assertions that actually matter, because a plausible "simplification"
// would break exactly these:
//
//   1. A repeat whose sourceUrl is NULL is caught. `skipDuplicates` does NOT
//      collapse those rows (SQL treats every NULL as distinct — see
//      app/api/leads/upload/route.ts:91-100), so the planner takes NO sourceUrl
//      input at all and compares only the normalised email.
//   2. A row that already carries MX evidence ("valid"/"invalid") is NEVER
//      demoted to "duplicate". That is what keeps the owner's valid/invalid
//      counts unchanged by a dedupe pass, and it is why "duplicate" must never
//      be folded into "invalid".
//
// The module under test has zero imports on purpose (all the DB work lives in the
// sibling lib/lead-duplicates.ts), so it is loaded with the house `require`
// pattern (HOW_WE_MOVE_FAST §4) — a bare `import ... from
// "../lib/lead-duplicate-plan.ts"` fails `tsc` because the project does not
// enable `allowImportingTsExtensions`.

/* eslint-disable @typescript-eslint/no-require-imports */
const { planDuplicateMarks, normalizeLeadEmail } = require("../lib/lead-duplicate-plan") as typeof import("../lib/lead-duplicate-plan");
/* eslint-enable @typescript-eslint/no-require-imports */

function row(
  id: string,
  email: string | null,
  minutes: number,
  validationStatus: string | null = "unchecked",
  duplicateOfId: string | null = null,
) {
  return { id, email, createdAt: new Date(Date.UTC(2026, 8, 30, 12, minutes)), validationStatus, duplicateOfId };
}

test("normalisation is trimmed and case-insensitive", () => {
  assert.equal(normalizeLeadEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeLeadEmail(null), "");
  assert.equal(normalizeLeadEmail("   "), "");
});

test("the later of two identical addresses is flagged, pointing at the earlier one", () => {
  const marks = planDuplicateMarks([row("early", "ada@example.com", 0), row("late", "ada@example.com", 5)]);
  assert.deepEqual(marks, [{ id: "late", duplicateOfId: "early" }]);
});

test("case and surrounding whitespace do NOT hide a repeat", () => {
  const marks = planDuplicateMarks([
    row("early", "Ada@Example.com", 0),
    row("late", "  ada@EXAMPLE.com ", 5),
  ]);
  assert.deepEqual(marks, [{ id: "late", duplicateOfId: "early" }]);
});

test("a NULL-sourceUrl repeat is caught — the planner never consults sourceUrl", () => {
  // Both rows as they arrive from an upload: same email, sourceUrl NULL for each.
  // If this rule relied on the unique constraint, SQL would treat the two NULLs
  // as distinct and neither row would be flagged.
  const marks = planDuplicateMarks([row("first", "ada@example.com", 0), row("second", "ada@example.com", 1)]);
  assert.deepEqual(marks, [{ id: "second", duplicateOfId: "first" }]);
});

test("a genuinely new address is not flagged", () => {
  const marks = planDuplicateMarks([
    row("a", "ada@example.com", 0),
    row("b", "grace@example.com", 1),
    row("c", "alan@example.com", 2),
  ]);
  assert.deepEqual(marks, []);
});

test("an already-validated row is never demoted — the unvalidated repeat is the one flagged", () => {
  // earliest is unchecked, later one is valid: the valid row keeps its MX
  // evidence and becomes the canonical, so the earlier unvalidated row is the
  // duplicate. Either way nothing that was validated changes status.
  const marks = planDuplicateMarks([
    row("unchecked-earlier", "ada@example.com", 0),
    row("valid-later", "ada@example.com", 5, "valid"),
  ]);
  assert.deepEqual(marks, [{ id: "unchecked-earlier", duplicateOfId: "valid-later" }]);
});

test("a valid or invalid row is never turned into a duplicate", () => {
  const marks = planDuplicateMarks([
    row("unchecked-earlier", "ada@example.com", 0),
    row("valid-later", "ada@example.com", 5, "valid"),
    row("unchecked-bob", "bob@example.com", 1),
    row("invalid-later", "bob@example.com", 6, "invalid"),
  ]);
  assert.deepEqual(
    marks.sort((a, b) => (a.id < b.id ? -1 : 1)),
    [
      { id: "unchecked-bob", duplicateOfId: "invalid-later" },
      { id: "unchecked-earlier", duplicateOfId: "valid-later" },
    ],
  );
});

test("an already-correct duplicate produces no mark (a dedupe pass is idempotent)", () => {
  const marks = planDuplicateMarks([
    row("early", "ada@example.com", 0),
    row("late", "ada@example.com", 5, "duplicate", "early"),
  ]);
  assert.deepEqual(marks, []);
});

test("a duplicate pointing at the wrong row is re-pointed", () => {
  const marks = planDuplicateMarks([
    row("early", "ada@example.com", 0),
    row("late", "ada@example.com", 5, "duplicate", "some-other-lead"),
  ]);
  assert.deepEqual(marks, [{ id: "late", duplicateOfId: "early" }]);
});

test("a timestamp tie is broken deterministically by id", () => {
  const marksA = planDuplicateMarks([row("zzz", "ada@example.com", 0), row("aaa", "ada@example.com", 0)]);
  const marksB = planDuplicateMarks([row("aaa", "ada@example.com", 0), row("zzz", "ada@example.com", 0)]);
  assert.deepEqual(marksA, [{ id: "zzz", duplicateOfId: "aaa" }]);
  assert.deepEqual(marksB, marksA);
});

test("rows with no email at all are ignored", () => {
  const marks = planDuplicateMarks([row("a", null, 0), row("b", "   ", 1), row("c", "", 2)]);
  assert.deepEqual(marks, []);
});
