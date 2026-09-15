import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeads, type SearchResult } from "../src/lead";

const result: SearchResult = {
  title: "Acme Roofing | Contact",
  url: "https://acme.co",
  snippet: "",
};

test("builds one lead per email, reusing first name/phone for later ones", () => {
  const leads = buildLeads(result, ["a@x.co", "b@y.co"], ["(555) 123-4567"], ["Ann"]);
  assert.equal(leads.length, 2);
  assert.equal(leads[0].email, "a@x.co");
  assert.equal(leads[0].contactName, "Ann");
  assert.equal(leads[1].email, "b@y.co");
  assert.equal(leads[1].contactName, "Ann"); // falls back to first contact name
  assert.equal(leads[0].businessName, "Acme Roofing");
});

test("falls back to a single phone/name-only lead when no email exists", () => {
  const leads = buildLeads(result, [], ["(555) 123-4567"], ["Bob"]);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].email, null);
  assert.equal(leads[0].phone, "(555) 123-4567");
  assert.equal(leads[0].contactName, "Bob");
});

test("returns nothing when no email, phone, or name was found", () => {
  assert.deepEqual(buildLeads(result, [], [], []), []);
});