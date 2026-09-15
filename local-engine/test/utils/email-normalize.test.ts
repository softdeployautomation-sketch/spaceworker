import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEmailCellToAddresses, coerceEmailString } from "../../src/utils/email-normalize";

test("parses a single normalized address", () => {
  assert.deepEqual(normalizeEmailCellToAddresses("John@Example.com"), ["john@example.com"]);
});

test("parses comma/space separated lists", () => {
  assert.deepEqual(normalizeEmailCellToAddresses("a@x.co, b@y.co"), ["a@x.co", "b@y.co"]);
});

test("strips mailto: and angle brackets", () => {
  assert.deepEqual(normalizeEmailCellToAddresses("mailto:Sales@Acme.co"), ["sales@acme.co"]);
  assert.deepEqual(normalizeEmailCellToAddresses("<bob@acme.co>"), ["bob@acme.co"]);
});

test("handles null / empty input", () => {
  assert.deepEqual(normalizeEmailCellToAddresses(null), []);
  assert.deepEqual(normalizeEmailCellToAddresses("   "), []);
});

test("coerceEmailString strips trailing punctuation (does not substring-extract)", () => {
  // Faithful to the Python original: coerce only strips wrappers/trailing punctuation;
  // it is the extract_emails() first pass (in normalizeEmailCellToAddresses) that
  // actually pulls the address out of surrounding prose.
  assert.equal(coerceEmailString("reach me at bill@acme.co."), "reach me at bill@acme.co");
  assert.equal(coerceEmailString("mailto:bill@acme.co"), "bill@acme.co");
});