// TASK_201 S6 — pins the fix for the permanently-disabled "Save as template"
// button: decoupled campaigns (subjects[]/bodies[] columns, NO variant rows —
// i.e. every campaign created from the web form since Task 29) must resolve to
// their real content, and legacy variant-row campaigns must keep working.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  campaignTemplateContent,
  hasTemplateContent,
} from "@/lib/campaign-template-content";

test("decoupled campaign (subjects/bodies columns, no variants) resolves to its lists", () => {
  const c = {
    subjects: ["Subject one", "Subject two"],
    bodies: ["<p>Body one</p>", "<p>Body two</p>"],
    variants: [],
  };
  assert.deepEqual(campaignTemplateContent(c), {
    subjects: ["Subject one", "Subject two"],
    bodies: ["<p>Body one</p>", "<p>Body two</p>"],
  });
  assert.equal(hasTemplateContent(c), true);
});

test("legacy variant-row campaign (no decoupled lists) maps subject/bodyHtml pairwise", () => {
  const c = {
    variants: [
      { id: "v1", subject: "A", bodyHtml: "<p>a</p>" },
      { id: "v2", subject: "B", bodyHtml: "<p>b</p>" },
    ],
  };
  assert.deepEqual(campaignTemplateContent(c), {
    subjects: ["A", "B"],
    bodies: ["<p>a</p>", "<p>b</p>"],
  });
  assert.equal(hasTemplateContent(c), true);
});

test("campaign with no content anywhere is NOT template-able (button stays disabled)", () => {
  const c = { subjects: [], bodies: [], variants: [] };
  assert.deepEqual(campaignTemplateContent(c), { subjects: [], bodies: [] });
  assert.equal(hasTemplateContent(c), false);
});

test("missing/undefined fields never crash and read as empty", () => {
  const c = {};
  assert.deepEqual(campaignTemplateContent(c), { subjects: [], bodies: [] });
  assert.equal(hasTemplateContent(c), false);
  const partial = { subjects: null, bodies: undefined, variants: null };
  assert.equal(hasTemplateContent(partial), false);
});

test("whitespace-only and nullish entries are trimmed/dropped", () => {
  const c = {
    subjects: ["  Real subject  ", "   ", ""],
    bodies: ["<p>real body</p>", " ", null as unknown as string],
    variants: [],
  };
  assert.deepEqual(campaignTemplateContent(c), {
    subjects: ["Real subject"],
    bodies: ["<p>real body</p>"],
  });
});

test("variant rows with a null subject/bodyHtml are dropped, not counted", () => {
  const c = {
    variants: [
      { subject: null, bodyHtml: "<p>orphan body</p>" },
      { subject: "   ", bodyHtml: "<p>blank subject</p>" },
      { subject: "Good", bodyHtml: "" },
      { subject: "Keeper", bodyHtml: "<p>kept</p>" },
    ],
  };
  assert.deepEqual(campaignTemplateContent(c), {
    subjects: ["Keeper"],
    bodies: ["<p>kept</p>"],
  });
  assert.equal(hasTemplateContent(c), true);
});

test("decoupled lists win over variant rows when both exist (precedence pinned)", () => {
  const c = {
    subjects: ["Decoupled subject"],
    bodies: ["<p>decoupled body</p>"],
    variants: [{ subject: "Legacy", bodyHtml: "<p>legacy</p>" }],
  };
  assert.deepEqual(campaignTemplateContent(c), {
    subjects: ["Decoupled subject"],
    bodies: ["<p>decoupled body</p>"],
  });
});

test("one-sided decoupled content (subjects only) still resolves and counts as content", () => {
  const c = { subjects: ["Only a subject"], bodies: [], variants: [] };
  assert.deepEqual(campaignTemplateContent(c), {
    subjects: ["Only a subject"],
    bodies: [],
  });
  // Not BOTH lists → not immediately usable as a template.
  assert.equal(hasTemplateContent(c), false);
});
