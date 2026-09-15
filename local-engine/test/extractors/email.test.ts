import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEmails } from "../../src/extractors/email";

test("extracts plain emails from text and lowercases/sorts them", () => {
  const out = extractEmails("Reach Bob at Bob@Acme.com and Amy@Corp.org today");
  assert.deepEqual(out, ["amy@corp.org", "bob@acme.com"]);
});

test("extracts mailto: links from HTML", () => {
  const html = '<a href="mailto:sales@acme.co">Sales</a>';
  assert.deepEqual(extractEmails("", html), ["sales@acme.co"]);
});

test("recovers a genuine email whose local-part picks up a leading dot (RFC local-part)", () => {
  // Verified live from real extracted output (.574@hotmail.com, .perez@gmail.com).
  assert.deepEqual(extractEmails("List: .574@hotmail.com and .perez@gmail.com"), [
    "574@hotmail.com",
    "perez@gmail.com",
  ]);
});

test("filters junk domains and junk prefixes", () => {
  const out = extractEmails("noreply@example.com no-reply@test.com real@acme.io");
  assert.deepEqual(out, ["real@acme.io"]);
});

test("drops false file extensions that look like email TLDs", () => {
  // "image@2x.png" is not a real email.
  assert.deepEqual(extractEmails("bg@2x.png image@2x.png"), []);
});

test("strips trailing punctuation from an address", () => {
  assert.deepEqual(extractEmails("Send mail to John@X.com."), ["john@x.com"]);
});

test("deduplicates repeated addresses", () => {
  const out = extractEmails("a@b.co a@b.co A@B.CO");
  assert.deepEqual(out, ["a@b.co"]);
});