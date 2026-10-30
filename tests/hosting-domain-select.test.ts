import { test } from "node:test";
import assert from "node:assert/strict";

// TASK_249 — the pure rules behind the admin domain selectors.

import {
  apexOfHost,
  hostForZone,
  normalizeHostInput,
  resolvePurposeAccount,
  zoneMatchesHost,
} from "../lib/hosting/domain-select";

const LINKS = "2222222222222222222222222222222a";
const SITES = "1111111111111111111111111111111f";
const PUBLIC = "43b24dc00bea90102ede000000000000";

test("purpose pins: links and sites are independent", () => {
  const pins = { links: LINKS, sites: SITES, public: null };
  assert.equal(resolvePurposeAccount("links", pins), LINKS);
  assert.equal(resolvePurposeAccount("sites", pins), SITES);
});

test("public follows its own pin, else the LINKS pin (never sites)", () => {
  const pins = { links: LINKS, sites: SITES, public: PUBLIC };
  assert.equal(resolvePurposeAccount("public", pins), PUBLIC);

  const noPublic = { links: LINKS, sites: SITES, public: null };
  assert.equal(resolvePurposeAccount("public", noPublic), LINKS);

  const noPublicNoLinks = { links: null, sites: SITES, public: null };
  assert.equal(resolvePurposeAccount("public", noPublicNoLinks), null);
});

test("normalizeHostInput accepts URLs and host:port, rejects junk", () => {
  assert.equal(normalizeHostInput("https://Go.InstaWeb.top/"), "go.instaweb.top");
  assert.equal(normalizeHostInput("go.instaweb.top:443"), "go.instaweb.top");
  assert.equal(normalizeHostInput("GO.instaweb.top."), "go.instaweb.top");
  assert.equal(normalizeHostInput("not a host"), null);
  assert.equal(normalizeHostInput("localhost"), null);
  assert.equal(normalizeHostInput(""), null);
});

test("zoneMatchesHost: sites must be the apex, links/public one label deep", () => {
  assert.equal(zoneMatchesHost("example.com", "example.com", true), true);
  assert.equal(zoneMatchesHost("go.example.com", "example.com", true), false);
  assert.equal(zoneMatchesHost("go.example.com", "example.com", false), true);
  assert.equal(zoneMatchesHost("example.com", "example.com", false), false);
  assert.equal(zoneMatchesHost("a.b.example.com", "example.com", false), false);
  assert.equal(zoneMatchesHost("go.other.com", "example.com", false), false);
});

test("zoneMatchesHost handles a deeper zone (example.co.uk)", () => {
  assert.equal(zoneMatchesHost("example.co.uk", "example.co.uk", true), true);
  assert.equal(zoneMatchesHost("shop.example.co.uk", "example.co.uk", true), false);
  assert.equal(zoneMatchesHost("go.shop.example.co.uk", "shop.example.co.uk", false), true);
  assert.equal(zoneMatchesHost("go.example.co.uk", "shop.example.co.uk", false), false);
});

test("hostForZone builds the stored host", () => {
  assert.equal(hostForZone("example.com", "go", false), "go.example.com");
  assert.equal(hostForZone("example.com", "", true), "example.com");
  assert.equal(hostForZone("example.com", "bad.label", false), null);
  assert.equal(hostForZone("example.com", "-bad", false), null);
});

test("apexOfHost is a last-two-label fallback", () => {
  assert.equal(apexOfHost("go.example.com"), "example.com");
  assert.equal(apexOfHost("example.com"), "example.com");
});
