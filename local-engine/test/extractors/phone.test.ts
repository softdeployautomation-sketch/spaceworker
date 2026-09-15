import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPhones, cleanPhone } from "../../src/extractors/phone";

test("extracts common US formats", () => {
  assert.deepEqual(extractPhones("Call (555) 123-4567 or 555-123-4567"), ["(555) 123-4567", "555-123-4567"]);
});

test("extracts international format", () => {
  const out = extractPhones("Reach +44 20 7946 0958 today");
  assert.deepEqual(out, ["+44 20 7946 0958"]);
});

test("extracts from tel: href links in HTML", () => {
  const html = '<a href="tel:+44 20 7946 0958">Call</a>';
  assert.deepEqual(extractPhones("", html), ["+44 20 7946 0958"]);
});

test("excludes dates and ZIP+4 codes that look like phone numbers", () => {
  assert.deepEqual(extractPhones("Date: 2024-01-15, ZIP 12345-6789"), []);
});

test("cleanPhone strips non-phone characters and rejects too-short numbers", () => {
  assert.equal(cleanPhone("(555) 123-4567"), "(555) 123-4567");
  assert.equal(cleanPhone("  555-123-4567  "), "555-123-4567");
  assert.equal(cleanPhone("123"), ""); // too few digits
  assert.equal(cleanPhone(""), "");
});