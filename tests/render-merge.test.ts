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

// TASK_234 — name derived from the EMAIL ADDRESS alone (no extractor/CSV name).
// The whole point: `((name))`/`{{name}}` must resolve from the address when the
// variables carry nothing, and must NEVER reach the recipient as a raw token.

test("((name)) resolves from the recipient's email when no name variable exists", () => {
  assert.equal(renderMerge("Hi ((name))!", {}, { email: "jane.smith@x.com" }), "Hi Jane!");
  assert.equal(renderMerge("Hi {{name}}!", {}, { email: "john@x.com" }), "Hi John!");
  // Hyphen / underscore / plus-tag / trailing digits — the GMass-style heuristics.
  assert.equal(renderMerge("((name))", {}, { email: "mary-jane@x.com" }), "Mary");
  assert.equal(renderMerge("((name))", {}, { email: "sam_wells@x.com" }), "Sam");
  assert.equal(renderMerge("((name))", {}, { email: "jane+news@x.com" }), "Jane");
  assert.equal(renderMerge("((name))", {}, { email: "alex99@x.com" }), "Alex");
});

test("a stored name column still wins over the email-derived name", () => {
  // Variables first, email only as the fallback source — never a replacement.
  assert.equal(renderMerge("Hi ((name))", { contactName: "Bo" }, { email: "jane@x.com" }), "Hi Bo");
  assert.equal(renderMerge("Hi {{name}}", { name: "Boss" }, { email: "jane@x.com" }), "Hi Boss");
  assert.equal(
    renderMerge("Hi {{firstName}}", { firstname: "Ada" }, { email: "bo@x.com" }),
    "Hi Ada",
  );
});

test("role mailboxes (info@…) derive no name — default, else empty, never 'Info'", () => {
  assert.equal(renderMerge("Hi {{name|there}}!", {}, { email: "info@x.com" }), "Hi there!");
  assert.equal(renderMerge("Hi ((name))!", {}, { email: "sales@x.com" }), "Hi !");
  assert.equal(renderMerge("Hi {{name}}!", {}, { email: "a@x.com" }), "Hi !");
  assert.equal(renderMerge("Hi ((name))!", {}, { email: "plainuser" }), "Hi !");
});

test("((name)) is never delivered as a raw token, even with nothing to fill it", () => {
  // The owner's core requirement: a placeholder must not show naked by mistake.
  assert.equal(renderMerge("Hi ((name))", {}, {}), "Hi ");
  assert.equal(renderMerge("Hi ((name|there))", {}, {}), "Hi there");
});

test("((…)) outside the known key set passes through untouched", () => {
  // Guards existing bodies: literal double-paren text is never eaten.
  assert.equal(renderMerge("see ((notes)) here", {}, {}), "see ((notes)) here");
  assert.equal(renderMerge("(single parens) stay", {}, {}), "(single parens) stay");
});

test("the |default renders when nothing resolves, in both syntaxes", () => {
  assert.equal(renderMerge("Hi {{nope|friend}}", {}, {}), "Hi friend");
  assert.equal(renderMerge("Hi {{name|there}}", {}, {}), "Hi there");
  assert.equal(renderMerge("Hi ((name|there))", {}, {}), "Hi there");
  // An empty default still means "empty", not the raw token.
  assert.equal(renderMerge("Hi {{name|}}", {}, { email: "info@x.com" }), "Hi ");
});

test("{{email}} renders the recipient's address passed at send time", () => {
  assert.equal(renderMerge("<{{email}}>", {}, { email: "jane@x.com" }), "<jane@x.com>");
  // Without it, unknown-key rules apply — empty, never raw.
  assert.equal(renderMerge("<{{email}}>", {}, {}), "<>");
});
