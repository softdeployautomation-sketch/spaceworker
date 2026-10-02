// TASK_156 C1 — the Cyber Lab's pure, testable core (no DB, no network).
//
// WHAT THIS FILE PROVES (run: npx tsx --test tests/lab-gate.test.ts):
//   1. `canonicalAupText` is deterministic and version-stamped — the wording the
//      onboarding screen shows and the wording hashed into a LabConsent row are
//      the same string (the C0 "can never drift" contract).
//   2. `consentHash` binds (userId, termsVersion, AUP text): a different user, a
//      different version, or a re-worded policy hash differently, so a stored hash
//      stays provable against the exact text that was accepted.
//   3. `isCatalogStale` implements the §12.1 research gate: a row whose
//      `staleAfter` has passed is hidden from the UI and flagged
//      "refresh required" — the opposite of a tool list that quietly rots.
//   4. `CATALOG_SEED` integrity: every starter row carries the §12.1-mandated
//      fields (ATT&CK technique ids, licence where known, real-world derivation,
//      legal basis), covers all four lab classes, and has no duplicate slugs.
//   5. `RESEARCH_FEEDS` integrity: the feed list the Research page renders is
//      stable, unique-id'd, and every entry names what a pull refreshes.
//
// Everything below drives the REAL `lib/lab/*` modules — with the `server-only`
// and `@/lib/*` imports swapped for recording fakes through the house require
// hook — except lib/lab/aup.ts, which has NO server import and loads directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import {
  CYBERLAB_AUP_SECTIONS,
  CYBERLAB_AUP_TITLE,
  CYBERLAB_AUP_VERSION,
  canonicalAupText,
} from "../lib/lab/aup";

// --- require-hook stub (house pattern, cf. tests/module-store.test.ts) -------
// lib/lab/{consent,tools,catalog-seed,research}.ts each import "server-only"
// plus `@/lib/db` / `@/lib/admin-settings` / `@/lib/entitlements`. Swap those for
// fakes at load so we can drive the REAL module code with no Postgres.

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const LAB_FILES = new Set(["lib/lab/consent.ts", "lib/lab/tools.ts", "lib/lab/catalog-seed.ts", "lib/lab/research.ts"]);

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  // Filled in load order below: consent → tools → catalog-seed → research, so a
  // later module's relative import resolves to the REAL earlier one (which itself
  // loaded against the fakes). catalogue-seed.ts needs the real ATTACK_RELEASE.
  const resolved: Record<string, unknown> = {};
  (globalThis as Record<string, unknown>).__labResolved = resolved;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    const base = from.slice(from.lastIndexOf("/lib/lab/") + 1);
    if (LAB_FILES.has(base)) {
      if (request === "@/lib/db") return { db: {} };
      if (request === "@/lib/admin-settings") return { getAdminSettings: async () => ({}) };
      if (request === "@/lib/entitlements") return { hasEntitlement: async () => ({ allowed: false }) };
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-export the REAL aup module so relative imports keep working under the hook.
      if (request === "./aup") return require("../lib/lab/aup");
      if (request === "./consent" && resolved.consent) return resolved.consent;
      if (request === "./tools" && resolved.tools) return resolved.tools;
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports -- house stub pattern (cf. tests/module-store.test.ts): loads the REAL lib/lab modules after the require hook above swapped their server-only/DB imports for fakes. */
const consentMod = require("../lib/lab/consent") as typeof import("../lib/lab/consent");
const toolsMod = require("../lib/lab/tools") as typeof import("../lib/lab/tools");
const resolved = (globalThis as Record<string, unknown>).__labResolved as Record<string, unknown>;
resolved.consent = consentMod;
resolved.tools = toolsMod;
const seedMod = require("../lib/lab/catalog-seed") as typeof import("../lib/lab/catalog-seed");
const researchMod = require("../lib/lab/research") as typeof import("../lib/lab/research");
/* eslint-enable @typescript-eslint/no-require-imports */

// --- 1+2. AUP canonical text + consent hash -----------------------------------

test("CYBERLAB_AUP_VERSION matches the migration default (the gate's current dial value)", () => {
  assert.equal(CYBERLAB_AUP_VERSION, "2026-10-02");
});

test("canonicalAupText is deterministic and version-stamped", () => {
  const a = canonicalAupText();
  const b = canonicalAupText(CYBERLAB_AUP_VERSION);
  assert.equal(a, b);
  assert.ok(a.startsWith(`${CYBERLAB_AUP_TITLE} v${CYBERLAB_AUP_VERSION}`));
  for (const section of CYBERLAB_AUP_SECTIONS) {
    assert.ok(a.includes(section.heading), `missing section: ${section.heading}`);
  }
});

test("the AUP covers the hard lines a user must read in advance", () => {
  const text = canonicalAupText().toLowerCase();
  assert.ok(text.includes("authorized targets"), "must name authorized targets");
  assert.ok(text.includes("abuse"), "must name the abuse sentinel");
  assert.ok(text.includes("law enforcement"), "must name LE cooperation");
});

// --- 3. The §12.1 stale contract ------------------------------------------------

test("isCatalogStale: null staleAfter never hides; past dates hide; future show", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  assert.equal(toolsMod.isCatalogStale({ staleAfter: null }, now), false);
  assert.equal(toolsMod.isCatalogStale({ staleAfter: new Date("2026-10-01T00:00:00Z") }, now), true);
  assert.equal(toolsMod.isCatalogStale({ staleAfter: new Date("2026-10-02T00:00:00Z") }, now), true);
  assert.equal(toolsMod.isCatalogStale({ staleAfter: new Date("2026-10-03T00:00:00Z") }, now), false);
});

// --- 4. Seed integrity -----------------------------------------------------------

test("CATALOG_SEED covers all four lab classes with unique slugs", () => {
  const slugs = seedMod.CATALOG_SEED.map((r) => r.slug);
  assert.equal(new Set(slugs).size, slugs.length, "duplicate slugs");
  const classes: Set<string> = new Set(seedMod.CATALOG_SEED.map((r) => r.klass));
  for (const klass of ["network", "email", "dns", "defensive"]) {
    assert.ok(classes.has(klass), `missing class: ${klass}`);
  }
});

test("every seed row carries the §12.1-mandated fields", () => {
  for (const row of seedMod.CATALOG_SEED) {
    assert.ok(row.slug && row.name, `${row.slug}: needs slug + name`);
    assert.ok(row.kind === "offensive" || row.kind === "defensive", `${row.slug}: bad kind`);
    assert.ok(Array.isArray(row.techniqueIds), `${row.slug}: techniqueIds must be an array`);
    assert.ok(row.derivation.length > 20, `${row.slug}: needs a real-world derivation`);
    assert.ok(row.legalBasis.length > 20, `${row.slug}: needs a legal basis`);
  }
});

test("every OFFENSIVE seed row is attested-target bound by its own legalBasis", () => {
  for (const row of seedMod.CATALOG_SEED.filter((r) => r.kind === "offensive")) {
    const basis = row.legalBasis.toLowerCase();
    assert.ok(
      basis.includes("attested") || basis.includes("allow-list") || basis.includes("own"),
      `${row.slug}: offensive row must name its attestation boundary`,
    );
  }
});

// --- 5. Research feed integrity ---------------------------------------------------

test("ATTACK_RELEASE pins a real release with a pin date", () => {
  assert.ok(toolsMod.ATTACK_RELEASE.version.length > 0);
  assert.ok(!Number.isNaN(Date.parse(toolsMod.ATTACK_RELEASE.releasedAt)));
  assert.ok(!Number.isNaN(Date.parse(toolsMod.ATTACK_RELEASE.pinnedAt)));
});

test("RESEARCH_FEEDS: unique ids, every entry names what a pull refreshes", () => {
  const ids = researchMod.RESEARCH_FEEDS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate feed ids");
  assert.ok(ids.includes("attack"), "ATT&CK must be a feed");
  for (const feed of researchMod.RESEARCH_FEEDS) {
    assert.ok(feed.label && feed.url.startsWith("https://"), `${feed.id}: real label + https url`);
    assert.ok(feed.refreshes.length > 10, `${feed.id}: must name what a pull refreshes`);
  }
});

test("consentHash binds user + version + text (any change hashes differently)", () => {
  const base = consentMod.consentHash("user-1", CYBERLAB_AUP_VERSION);
  assert.equal(base.length, 64, "sha256 hex");
  assert.notEqual(consentMod.consentHash("user-2", CYBERLAB_AUP_VERSION), base);
  assert.notEqual(consentMod.consentHash("user-1", "2099-01-01"), base);
  assert.equal(consentMod.consentHash("user-1", CYBERLAB_AUP_VERSION), base);
});
