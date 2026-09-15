import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBusinessName, extractContactNames, extractNamesFromEmail } from "../../src/extractors/name";

test("extractBusinessName takes the first non-common part after a separator", () => {
  assert.equal(extractBusinessName("Acme Roofing | Contact Us"), "Acme Roofing");
  assert.equal(extractBusinessName("About Us - Smith & Sons General Contractors"), "Smith & Sons General Contractors");
});

test("extractBusinessName strips trailing corporate tags and marks", () => {
  assert.equal(extractBusinessName("Mega Inc."), "Mega");
  assert.equal(extractBusinessName("Widgets LLC"), "Widgets");
  assert.equal(extractBusinessName("Widgets Co™"), "Widgets Co");
});

test("extractBusinessName returns empty for short/empty input", () => {
  assert.equal(extractBusinessName(""), "");
  assert.equal(extractBusinessName("H"), "");
});

test("extractContactNames finds titled names and contact-label names", () => {
  const out = extractContactNames(
    "Contact: Dr. John Smith. Manager: Jane Roe. Founder: Alice Brown.",
  );
  assert.ok(out.includes("Dr. John Smith"));
  assert.ok(out.includes("Jane Roe"));
  assert.ok(out.includes("Alice Brown"));
});

test("extractNamesFromEmail derives a name from dot/underscore-separated local part", () => {
  assert.equal(extractNamesFromEmail("john.smith@company.com"), "John Smith");
  assert.equal(extractNamesFromEmail("sarah_jane@co.com"), "Sarah Jane");
});

test("extractNamesFromEmail returns empty when no name can be derived", () => {
  assert.equal(extractNamesFromEmail("info@company.com"), "");
  assert.equal(extractNamesFromEmail(""), "");
});