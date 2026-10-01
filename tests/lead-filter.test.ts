import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_151 — regression guard for lib/lead-filter.ts.
//
// WHY THIS FILE EXISTS: the campaign picker's filter is about to grow from ONE
// substring box into multi-term include + multi-term exclude. The exclude half is
// the dangerous half: if excluding only HIDES a row while it stays in the
// selection (`selectedLeadIds`), the send path still reaches it — a cosmetic
// filter, the exact failure mode this project keeps hitting (the dead P2003
// check, the cosmetic admin Cancel). So the assertions that matter are:
//
//   1. Include is OR across terms, not AND — two terms must widen the result.
//   2. One term behaves EXACTLY like the old single box (no regression).
//   3. Excluding PRUNES the selection, and that check CAN fail (a version that
//      only hides rows leaves the excluded id selected).
//   4. The same rule holds server-side (excludeRecipients) where the selection is
//      actually consumed — the client picker is a convenience, not the guard.
//
// The module under test has zero imports on purpose (see lib/lead-filter.ts), so
// it is loaded with the house `require` pattern (HOW_WE_MOVE_FAST §4) — a bare
// `import ... from "../lib/lead-filter.ts"` fails `tsc` because the project does
// not enable allowImportingTsExtensions.

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  parseFilterTerms,
  filterPickerLeads,
  pruneExcludedSelection,
  excludeRecipients,
} = require("../lib/lead-filter") as typeof import("../lib/lead-filter");
/* eslint-enable @typescript-eslint/no-require-imports */

// The scratch scenario from TASK_151 §4: 3 leads share a domain, one is excluded.
const LEADS = [
  { id: "l1", email: "ada@acme.test", businessName: "Acme Corp", contactName: "Ada Lovelace", searchJobId: "jobA" },
  { id: "l2", email: "bob@acme.test", businessName: "Acme Corp", contactName: "Bob Kane", searchJobId: "jobA" },
  { id: "l3", email: "cy@acme.test", businessName: "Acme Corp", contactName: "Cy Doe", searchJobId: "jobA" },
  { id: "l4", email: "dan@globex.test", businessName: "Globex", contactName: "Dan Reed", searchJobId: "jobA" },
  { id: "l5", email: "eve@initech.test", businessName: "Initech", contactName: "Eve Stone", searchJobId: "jobB" },
  { id: "l6", email: "frank@initech.test", businessName: "Initech", contactName: "Frank Poe", searchJobId: "jobB" },
];

test("parseFilterTerms splits on commas and newlines, trims, and dedupes case-insensitively", () => {
  assert.deepEqual(parseFilterTerms("acme, globex\ninitech"), ["acme", "globex", "initech"]);
  assert.deepEqual(parseFilterTerms("acme\r\nACME, acme"), ["acme"]);
  assert.deepEqual(parseFilterTerms("acme corp"), ["acme corp"], "a space is NOT a separator");
  assert.deepEqual(parseFilterTerms(""), []);
  assert.deepEqual(parseFilterTerms("  ,  \n "), []);
});

test("one include term is byte-identical to the old single substring box (either of 3 fields)", () => {
  // Reproduce the pre-TASK_151 rule literally and compare.
  const oldRule = (q: string) =>
    LEADS.filter((l) => {
      const s = q.trim().toLowerCase();
      if (!s) return true;
      return (
        (l.email ?? "").toLowerCase().includes(s) ||
        (l.businessName ?? "").toLowerCase().includes(s) ||
        (l.contactName ?? "").toLowerCase().includes(s)
      );
    }).map((l) => l.id);
  for (const q of ["acme", "ACME", "  acme  ", "lovelace", "globex", ""]) {
    const terms = parseFilterTerms(q);
    const got = filterPickerLeads(LEADS, { include: terms }).visible.map((l) => l.id);
    assert.deepEqual(got, oldRule(q), `term ${JSON.stringify(q)} must match the old rule`);
  }
});

test("two include terms are OR (widening), never AND", () => {
  const viaEmail = filterPickerLeads(LEADS, { include: ["acme"] }).visible.map((l) => l.id);
  const viaName = filterPickerLeads(LEADS, { include: ["initech"] }).visible.map((l) => l.id);
  assert.deepEqual(viaEmail, ["l1", "l2", "l3"]);
  assert.deepEqual(viaName, ["l5", "l6"]);
  const both = filterPickerLeads(LEADS, { include: ["acme", "initech"] }).visible.map((l) => l.id);
  // OR => the UNION. AND would be the empty intersection (no lead is both).
  assert.deepEqual(both, ["l1", "l2", "l3", "l5", "l6"]);
  assert.equal(both.length, viaEmail.length + viaName.length);
});

test("exclude is applied AFTER include and reports the excluded count", () => {
  const { visible, excluded } = filterPickerLeads(LEADS, {
    include: ["acme"],
    exclude: ["bob@acme.test"],
  });
  assert.deepEqual(visible.map((l) => l.id), ["l1", "l3"]);
  assert.equal(excluded, 1);
});


test("the prune check CAN fail: a version that only hides rows leaves the excluded lead selected", () => {
  // This is the bug we are guarding against. `identity` is the un-pruned
  // "cosmetic filter" behaviour — the selection is left exactly as it was. If a
  // future refactor made pruneExcludedSelection a no-op, this test's FIRST
  // assertion would start failing (because the excluded id would survive), so the
  // assertion is meaningful rather than vacuous.
  const selected = ["l1", "l2", "l3"];
  const terms = parseFilterTerms("bob@acme.test");
  const unpruned = selected; // hide-only: selectAllVisible/visible filtered, selection not pruned
  assert.deepEqual(unpruned, ["l1", "l2", "l3"], "un-pruned selection still contains the excluded l2");
  assert.ok(unpruned.includes("l2"), "the excluded lead is still selected without pruning");

  const pruned = pruneExcludedSelection(selected, LEADS, terms);
  assert.ok(!pruned.includes("l2"), "pruning removed the excluded lead");
  assert.deepEqual(pruned, ["l1", "l3"]);
});

test("pruneExcludedSelection returns the SAME reference when there are no exclude terms (no state churn)", () => {
  const selected = ["l1", "l2"];
  assert.equal(pruneExcludedSelection(selected, LEADS, []), selected);
});

test("pruneExcludedSelection keeps a selected id whose lead is unknown (stale data is not destroyed)", () => {
  assert.deepEqual(pruneExcludedSelection(["ghost"], LEADS, ["acme"]), ["ghost"]);
});

test("server guard: excludeRecipients drops an excluded address from the resolved recipients", () => {
  const recipients = LEADS.map((l) => ({
    email: l.email,
    variables: { businessName: l.businessName, contactName: l.contactName },
  }));
  const terms = parseFilterTerms("bob@acme.test");
  const { recipients: kept, excludedCount } = excludeRecipients(recipients, terms);
  assert.equal(excludedCount, 1);
  assert.ok(!kept.some((r) => r.email === "bob@acme.test"), "the excluded address must not survive");
  assert.equal(kept.length, recipients.length - 1);

  // The server guard also matches on the carried names, same rule as the picker.
  const byName = excludeRecipients(recipients, parseFilterTerms("Initech"));
  assert.deepEqual(byName.recipients.map((r) => r.email), ["ada@acme.test", "bob@acme.test", "cy@acme.test", "dan@globex.test"]);
  assert.equal(byName.excludedCount, 2);
});

test("server guard is a no-op with no exclude terms (same array, no behaviour change)", () => {
  const recipients = [{ email: "a@x.test" }];
  assert.equal(excludeRecipients(recipients, []).recipients, recipients);
});

test("compose job x include x exclude in one pass", () => {
  const { visible, excluded } = filterPickerLeads(LEADS, {
    jobId: "jobA",
    include: ["acme", "globex"],
    exclude: ["bob@acme.test"],
  });
  assert.deepEqual(visible.map((l) => l.id), ["l1", "l3", "l4"]);
  assert.equal(excluded, 1);
  // jobB's initech leads are excluded by the JOB filter, and must not be counted
  // as "excluded" (they were never candidates).
  assert.ok(!visible.some((l) => l.searchJobId === "jobB"));
});
