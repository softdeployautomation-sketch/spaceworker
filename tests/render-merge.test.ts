import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMerge } from "../lib/render-merge";
import { parseRecipientsCsv } from "../lib/csv";

// TASK_145 — regression guard for merge-variable resolution.
//
// WHY THIS FILE EXISTS: a CSV upload and a picked Lead store their merge keys in
// different shapes, because lib/csv.ts lowercases every header while
// leadToRecipient() keeps camelCase. Under the original exact-key lookup that
// meant:
//
//   - every CSV recipient ("firstname" stored) rendered the UI's OWN documented
//     example `{{firstName}}` as an empty string — a real recipient saw "Hi ,";
//   - `{{contactName}}` was the only token that ever worked, and only for leads.
//
// No single template could address both sources, and the failure was silent: a
// blank, never an error. These tests pin the resolution rules that replaced it.

test("a CSV row resolves the exact stored key", () => {
  const { recipients } = parseRecipientsCsv("email,firstname,company\nada@x.com,Ada,ACME\n");
  assert.equal(renderMerge("Hi {{firstname}}", recipients[0].variables), "Hi Ada");
});

test("a CSV row also resolves the camelCase form the UI documents", () => {
  const { recipients } = parseRecipientsCsv("email,firstName,company\nada@x.com,Ada,ACME\n");
  // Stored lowercased by lib/csv.ts's normalizeHeader — must still render.
  assert.deepEqual(recipients[0].variables, { firstname: "Ada", company: "ACME" });
  assert.equal(renderMerge("Hi {{firstName}}", recipients[0].variables), "Hi Ada");
  assert.equal(renderMerge("Hi {{firstname}}", recipients[0].variables), "Hi Ada");
});

test("a picked Lead resolves its camelCase keys and the normalized spellings", () => {
  const vars = { contactName: "Bo", businessName: "Bocorp" };
  assert.equal(renderMerge("Hi {{contactName}}", vars), "Hi Bo");
  assert.equal(renderMerge("Hi {{contactname}}", vars), "Hi Bo");
  assert.equal(renderMerge("Hi {{Contact Name}}", vars), "Hi Bo");
  assert.equal(renderMerge("Hi {{contact_name}}", vars), "Hi Bo");
});

test("{{name}} is the one token that works for both sources", () => {
  const lead = { contactName: "Bo", businessName: "Bocorp" };
  const csv = parseRecipientsCsv("email,firstName\nada@x.com,Ada\n").recipients[0].variables;
  assert.equal(renderMerge("Hi {{name}}", lead), "Hi Bo");
  assert.equal(renderMerge("Hi {{name}}", csv), "Hi Ada");
  // Business-only recipient still gets something human rather than a blank.
  assert.equal(renderMerge("Hi {{name}}", { businessName: "Bocorp" }), "Hi Bocorp");
  // The alias skips an empty value instead of stopping at it.
  assert.equal(renderMerge("Hi {{name}}", { contactName: "", firstName: "Ada" }), "Hi Ada");
});

test("an exactly-named column always wins over the {{name}} alias", () => {
  assert.equal(renderMerge("Hi {{name}}", { name: "Boss", contactName: "Bo" }), "Hi Boss");
});

test("a CSV name column survives intact", () => {
  const { recipients } = parseRecipientsCsv("email,Name\nada@x.com,\"Ada, Lovelace\"\n");
  assert.equal(renderMerge("Hi {{Name}}", recipients[0].variables), "Hi Ada, Lovelace");
});

test("whitespace around and inside a key is cosmetic", () => {
  const vars = { firstname: "Ada" };
  assert.equal(renderMerge("Hi {{ firstname }}", vars), "Hi Ada");
  assert.equal(renderMerge("Hi {{ First Name }}", vars), "Hi Ada");
});

test("unknown keys render empty, never as a raw token or another recipient's value", () => {
  const vars = { firstname: "Ada" };
  assert.equal(renderMerge("Hi {{nope}}", vars), "Hi ");
  assert.equal(renderMerge("Hi {{ nope }}", vars), "Hi ");
  assert.equal(renderMerge("Hi {{}}", vars), "Hi {{}}");
});

test("<name> is not a placeholder — it is passed through untouched", () => {
  // Guards the documented contract at the top of lib/render-merge.ts: angle
  // brackets were never a supported syntax, so nobody should "fix" this by
  // making them one silently.
  assert.equal(renderMerge("Hi <name>", { firstname: "Ada" }), "Hi <name>");
});

test("multiple placeholders in one template all resolve", () => {
  const vars = { firstname: "Ada", company: "ACME" };
  assert.equal(
    renderMerge("Hi {{firstName}}, thanks for the time with {{company}}.", vars),
    "Hi Ada, thanks for the time with ACME.",
  );
});

test("an empty or blank template is returned as-is", () => {
  assert.equal(renderMerge("", { firstname: "Ada" }), "");
  assert.equal(renderMerge("No placeholders here.", { firstname: "Ada" }), "No placeholders here.");
});
