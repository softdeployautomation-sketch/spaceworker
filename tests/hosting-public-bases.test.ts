import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-require-imports -- house require-hook pattern for module stubs */

// TASK_249 — the public base resolver (lib/hosting/public-bases.ts).
//
// The setting stores a HOST ("dl.example.com"); both getters must return a FULL
// base URL, because every caller concatenates a path (`${base}/hf/<token>`).
// A bare host here shipped scheme-less links during the first TASK_249 attempt.
//
// Deliberately imports NOTHING that validates env at module load: this file is
// what caught lib/env being pulled into lib/hosting/providers.ts.

process.env.APP_BASE_URL = "https://app.test";
process.env.HOSTING_PUBLIC_BASE_URL = "https://dl.test";
process.env.PUBLIC_LINK_BASE_URL = "https://links.test";

const MOD = "../lib/hosting/public-bases.ts";

let setting: string | null = null;
let reads = 0;

function load() {
  delete require.cache[require.resolve(MOD)];
  const mod = require(MOD) as typeof import("../lib/hosting/public-bases");
  mod.setPublicBaseSettingsReader(async () => {
    reads += 1;
    return { hostingPublicLinkHost: setting };
  });
  return mod;
}

let mod: typeof import("../lib/hosting/public-bases");

beforeEach(() => {
  setting = null;
  reads = 0;
  mod = load();
});

test("resolvePublicBase turns a bare host into an https base", () => {
  assert.equal(
    mod.resolvePublicBase("shared.instaweb.top", "https://fallback.top"),
    "https://shared.instaweb.top"
  );
  assert.equal(
    mod.resolvePublicBase("https://Shared.InstaWeb.top/", "https://fallback.top"),
    "https://shared.instaweb.top"
  );
});

test("resolvePublicBase falls back when the shared host is empty", () => {
  assert.equal(mod.resolvePublicBase("", "https://fallback.top"), "https://fallback.top");
  assert.equal(mod.resolvePublicBase("  ", "https://fallback.top"), "https://fallback.top");
  assert.equal(mod.resolvePublicBase(null, "https://fallback.top/"), "https://fallback.top");
  assert.equal(mod.resolvePublicBase(undefined, "https://fallback.top"), "https://fallback.top");
});

test("both getters return the shared host with a scheme when set", async () => {
  setting = "dl.example.com";
  assert.equal(await mod.getFileBaseUrl(), "https://dl.example.com");
  assert.equal(await mod.getPublicLinkHost(), "https://dl.example.com");
});

test("the shared host is cached across calls", async () => {
  setting = "dl.example.com";
  assert.equal(await mod.getFileBaseUrl(), "https://dl.example.com");
  assert.equal(await mod.getPublicLinkHost(), "https://dl.example.com");
  assert.equal(reads, 1);
});

test("getPublicLinkHost falls back to PUBLIC_LINK_BASE_URL when unset", async () => {
  assert.equal(await mod.getPublicLinkHost(), "https://links.test");
});

test("getFileBaseUrl falls back to HOSTING_PUBLIC_BASE_URL when unset", async () => {
  assert.equal(await mod.getFileBaseUrl(), "https://dl.test");
});

test("resetPublicBaseCache drops the cached value", async () => {
  setting = "one.example.com";
  assert.equal(await mod.getFileBaseUrl(), "https://one.example.com");
  setting = "two.example.com";
  mod.resetPublicBaseCache();
  assert.equal(await mod.getFileBaseUrl(), "https://two.example.com");
  assert.equal(reads, 2);
});
