// TASK_156B Slice 2 — scan-first recon (run: npx tsx --test tests/lab-recon.test.ts).
//
// WHAT THIS FILE PROVES:
//   1. validateReconScope (pure): a declared recon scope normalises; a
//      non-normalisable value is `invalid`; a `network` broader than
//      RECON_MIN_NETWORK_PREFIX (/24) is `tooBroad`; duplicates collapse.
//   2. generateReconTelemetry (pure): same hard line as the smoke runner —
//      it refuses to run with no declared target and only ever emits values
//      inside the declared scope; synthetic + labelled throughout.
//   3. Engine (REAL startLabRun): a recon-class scenario runs to a SIGNED,
//      torn-down episode WITHOUT any attested LabTarget row (the whole point of
//      scan-first); the attested smoke path STILL requires attestation (proving
//      Slice 2 did not weaken it); a too-broad recon network is refused (403,
//      TargetRefusedError) AND audited (LabAbuseReport reason recon_scope_refused);
//      an invalid recon scope is a plain validation refusal (LabRunRefusedError,
//      no abuse report — mirrors the attest boundary note).
//
// HOW: same house require hook as tests/lab-c2.test.ts — every lib/lab/* module
// is the REAL one; only the edges are faked (in-memory db, mutable admin
// settings, entitlement decision). Governor stays OFF (shipped default).
//
// HONEST LIMIT: recon is SIMULATED today — synthetic telemetry, no packet
// leaves the platform. This proves the scan-first machinery and the scope
// guard, NOT live scanning (C2b, owner infra).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

process.env.DATABASE_URL = "postgresql://t156:t156@localhost:5432/task156_placeholder";
process.env.SESSION_SECRET = "task156-test-session-secret";
process.env.RESEND_API_KEY = "task156-test-resend";
process.env.EMAIL_FROM = "t156@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

type Row = Record<string, unknown>;

interface LabState {
  consentSigned: boolean;
  entitled: boolean;
  seq: number;
  targets: Row[];
  ranges: Row[];
  scenarios: Row[];
  episodes: Row[];
  reports: Row[];
}

const state: LabState = {
  consentSigned: true,
  entitled: true,
  seq: 0,
  targets: [],
  ranges: [],
  scenarios: [],
  episodes: [],
  reports: [],
};

const USER = "user-recon-1";

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key];
    if (expected instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== expected.getTime()) return false;
      continue;
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      const cond = expected as Row;
      if ("in" in cond && !(cond.in as unknown[]).includes(actual)) return false;
      if ("notIn" in cond && (cond.notIn as unknown[]).includes(actual)) return false;
      if ("not" in cond && actual === cond.not) return false;
      if ("gte" in cond) {
        if (!(actual instanceof Date) || actual.getTime() < (cond.gte as Date).getTime()) return false;
      }
      if ("gt" in cond) {
        if (!(actual instanceof Date) || actual.getTime() <= (cond.gt as Date).getTime()) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

const adminRow: Row = {
  governorEnabled: false,
  cyberlabEnabled: true,
  cyberlabFreeMaxConcurrentRanges: 1,
  cyberlabFreeMaxRangeMinutes: 30,
  cyberlabMaxRunsPerDay: 10,
  cyberlabMaxTargetsPerScenario: 10,
  cyberlabMaxEpisodesPerMonth: 20,
  cyberlabConsentTermsVersion: "vTest",
};

const fakeDb = {
  labConsent: {
    findFirst: async ({ where }: { where: Row }) =>
      state.consentSigned
        ? { id: "consent-1", userId: where.userId, termsVersion: where.termsVersion, signedAt: new Date(), hash: "h" }
        : null,
  },
  labTarget: {
    upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
      const key = where.userId_kind_value as { userId: string; kind: string; value: string };
      const existing = state.targets.find((t) => t.userId === key.userId && t.kind === key.kind && t.value === key.value);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row: Row = { id: `t${++state.seq}`, rangeId: null, attestationId: null, createdAt: new Date(), ...create };
      state.targets.push(row);
      return row;
    },
    findMany: async ({ where }: { where: Row }) => state.targets.filter((t) => matches(t, where)),
  },
  labRange: {
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: `r${++state.seq}`,
        ttlExpiresAt: null,
        consentId: null,
        credentialRef: null,
        queuedSlotId: null,
        teardownVerifiedAt: null,
        error: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      state.ranges.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) => state.ranges.find((r) => r.id === where.id) ?? null,
    findUniqueOrThrow: async ({ where }: { where: Row }) => {
      const found = state.ranges.find((r) => r.id === where.id);
      if (!found) throw new Error("lab_range_not_found");
      return found;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const found = state.ranges.find((r) => r.id === where.id);
      if (!found) throw new Error("lab_range_not_found");
      Object.assign(found, data);
      return found;
    },
    count: async ({ where }: { where: Row }) => state.ranges.filter((r) => matches(r, where)).length,
  },
  labScenario: {
    upsert: async ({ where, update, create }: { where: Row; update: Row; create: Row }) => {
      const existing = state.scenarios.find((s) => s.slug === where.slug);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const row: Row = {
        id: `s${++state.seq}`,
        techniqueIds: null,
        adversaryProfile: null,
        requiredCapabilities: null,
        blastRadius: null,
        cleanup: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...create,
      };
      state.scenarios.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) => state.scenarios.find((s) => s.slug === where.slug) ?? null,
    findMany: async ({ where }: { where: Row }) => state.scenarios.filter((s) => matches(s, where)),
  },
  labEpisode: {
    count: async ({ where }: { where: Row }) => state.episodes.filter((e) => matches(e, where)).length,
    create: async ({ data }: { data: Row }) => {
      const row: Row = {
        id: (data.id as string) ?? `ep${++state.seq}`,
        startedAt: null,
        endedAt: null,
        timeline: null,
        techniques: null,
        telemetrySignatures: null,
        outcome: null,
        evidenceManifest: null,
        signedHash: null,
        createdAt: new Date(),
        ...data,
      };
      state.episodes.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Row }) => state.episodes.find((e) => e.id === where.id) ?? null,
  },
  labAbuseReport: {
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `ab${++state.seq}`, rangeId: null, evidenceJson: null, severity: "low", status: "open", createdAt: new Date(), ...data };
      state.reports.push(row);
      return row;
    },
  },
};

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "@/lib/db") return { db: fakeDb };
    if (request === "@/lib/admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
    if (request === "@/lib/entitlements") {
      return { hasEntitlement: async () => (state.entitled ? { allowed: true, reason: "premium" } : { allowed: false, reason: "none" }) };
    }
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/resource-governor.ts")) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      if (request === "./entitlements") return { listEffectiveEntitlements: async () => ({ keys: [], premium: false, grants: [] }) };
      if (request === "./devices") return { recordAgentActionAudit: async () => {} };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../lib/lab/engine") as typeof import("../lib/lab/engine");
const targetsMod = require("../lib/lab/targets") as typeof import("../lib/lab/targets");
const episodeMod = require("../lib/lab/episode") as typeof import("../lib/lab/episode");
const reconCore = require("../lib/lab/recon-core") as typeof import("../lib/lab/recon-core");
const reconRunner = require("../lib/lab/recon-runner") as typeof import("../lib/lab/recon-runner");
const scenariosMod = require("../lib/lab/scenarios") as typeof import("../lib/lab/scenarios");
/* eslint-enable @typescript-eslint/no-require-imports */

const { startLabRun, LabRunRefusedError } = engine;
const { TargetRefusedError } = targetsMod;
const { verifyEpisodeSignature } = episodeMod;
const { validateReconScope, RECON_MIN_NETWORK_PREFIX, RECON_TECHNIQUE_IDS, RECON_SIGNATURE_IDS } = reconCore;
const { generateReconTelemetry } = reconRunner;
const { ensureReconScenario, ensureSmokeScenario, RECON_SCENARIO_SLUG, SMOKE_SCENARIO_SLUG } = scenariosMod;

beforeEach(async () => {
  state.consentSigned = true;
  state.entitled = true;
  state.targets = [];
  state.ranges = [];
  state.scenarios = [];
  state.episodes = [];
  state.reports = [];
  state.seq = 0;
  adminRow.cyberlabEnabled = true;
  adminRow.governorEnabled = false;
  adminRow.cyberlabMaxEpisodesPerMonth = 20;
  await ensureSmokeScenario();
  await ensureReconScenario();
});

// ---------------------------------------------------------------------------
// 1. validateReconScope (pure)
// ---------------------------------------------------------------------------

test("validateReconScope: normalises, collapses duplicates, splits invalid vs tooBroad", () => {
  const { kept, invalid, tooBroad } = validateReconScope([
    { kind: "host", value: " 10.9.0.5 " }, // normalises + trims
    { kind: "host", value: "10.9.0.5" }, // duplicate after normalisation
    { kind: "network", value: "10.9.0.0/24" }, // exactly /24 — allowed
    { kind: "network", value: "10.9.0.0/25" }, // narrower — allowed
    { kind: "network", value: "10.0.0.0/16" }, // too broad
    { kind: "network", value: "0.0.0.0/0" }, // too broad (the whole internet)
    { kind: "domain", value: "Example.COM" }, // normalises to lowercase
    { kind: "host", value: "not a host!!" }, // invalid
    { kind: "email", value: "nope" }, // invalid
  ]);

  assert.deepEqual(kept, [
    { kind: "host", value: "10.9.0.5" },
    { kind: "network", value: "10.9.0.0/24" },
    { kind: "network", value: "10.9.0.0/25" },
    { kind: "domain", value: "example.com" },
  ]);
  assert.deepEqual(invalid.map((i) => i.value), ["not a host!!", "nope"]);
  assert.ok(invalid.every((i) => i.reason === "not_normalized"));
  assert.deepEqual(tooBroad.map((t) => t.value), ["10.0.0.0/16", "0.0.0.0/0"]);
  assert.ok(tooBroad.every((t) => t.reason === "too_broad_scope"));
});

test("validateReconScope: the /24 boundary is inclusive (policy constant is /24)", () => {
  assert.equal(RECON_MIN_NETWORK_PREFIX, 24);
  // /24 kept, /23 refused — the boundary is exactly the constant.
  const { kept, tooBroad } = validateReconScope([
    { kind: "network", value: "192.168.1.0/24" },
    { kind: "network", value: "192.168.0.0/23" },
  ]);
  assert.deepEqual(kept.map((k) => k.value), ["192.168.1.0/24"]);
  assert.deepEqual(tooBroad.map((t) => t.value), ["192.168.0.0/23"]);
});

// ---------------------------------------------------------------------------
// 2. generateReconTelemetry (pure) — same hard line as the smoke runner
// ---------------------------------------------------------------------------

test("generateReconTelemetry: refuses with no declared target; synthetic + labelled", () => {
  const base = { rangeId: "r1", scenarioSlug: RECON_SCENARIO_SLUG, startedAt: new Date(), endedAt: new Date() };
  assert.throws(
    () => generateReconTelemetry({ ...base, targets: [] }),
    (err: Error) => err instanceof RangeError,
  );

  const t = generateReconTelemetry({
    ...base,
    targets: [
      { kind: "host", value: "10.9.0.5" },
      { kind: "network", value: "10.9.1.0/24" },
    ],
  });
  // surface.json + detections.json
  assert.equal(t.artefacts.length, 2);
  assert.deepEqual(t.techniques, [...RECON_TECHNIQUE_IDS]);
  assert.deepEqual(t.telemetrySignatures, [...RECON_SIGNATURE_IDS]);
  // Every artefact is self-describing as synthetic.
  for (const a of t.artefacts) assert.ok(a.content.includes('"synthetic": true'));
  // Timeline shape: created → scope_declared → one enumeration per target → trip → destroyed.
  const events = t.timeline.map((e) => e.event);
  assert.equal(events[0], "range.created");
  assert.equal(events[1], "recon.scope_declared");
  assert.equal(events.filter((e) => e === "recon.host_enumerated").length, 2);
  assert.ok(events.includes("detection.synthetic_trip"));
  assert.equal(events[events.length - 1], "range.destroyed");
});

// ---------------------------------------------------------------------------
// 3. Engine (REAL startLabRun) — scan-first, no attested device required
// ---------------------------------------------------------------------------

test("startLabRun(recon): runs to a SIGNED, torn-down episode with NO attested target", async () => {
  // No attestTarget() call anywhere — the whole point of scan-first. state.targets stays [].
  assert.equal(state.targets.length, 0);

  const result = await startLabRun({
    userId: USER,
    scenarioSlug: RECON_SCENARIO_SLUG,
    targets: [
      { kind: "host", value: "10.9.0.5" },
      { kind: "network", value: "10.9.1.0/24" },
    ],
  });

  assert.equal(result.mode, "dry-run");
  assert.equal(result.verified, true);
  assert.equal(result.targets.length, 2);
  assert.deepEqual(result.techniques, [...RECON_TECHNIQUE_IDS]);

  // Range reached torn_down with a verified teardown; episode signature recomputes true.
  const range = state.ranges.find((r) => r.id === result.rangeId)!;
  assert.equal(range.state, "torn_down");
  assert.ok(range.teardownVerifiedAt instanceof Date);
  assert.equal(await verifyEpisodeSignature(result.episodeId), true);
  // No abuse report on the happy path.
  assert.equal(state.reports.length, 0);
});

test("startLabRun(smoke): STILL requires attested targets — Slice 2 did not weaken it", async () => {
  // Two host targets, none attested → the attested smoke path must still refuse.
  await assert.rejects(
    () =>
      startLabRun({
        userId: USER,
        scenarioSlug: SMOKE_SCENARIO_SLUG,
        targets: [
          { kind: "host", value: "10.77.0.11" },
          { kind: "host", value: "10.77.0.12" },
        ],
      }),
    (err: Error) => err instanceof TargetRefusedError,
  );
  // The §5.2 audit fired and the range landed failed (never dangling live).
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].reason, "preflight_target_refused");
  const range = state.ranges[0];
  assert.equal(range.state, "failed");
});

test("startLabRun(recon): a too-broad network scope is refused (403) AND audited", async () => {
  await assert.rejects(
    () =>
      startLabRun({
        userId: USER,
        scenarioSlug: RECON_SCENARIO_SLUG,
        targets: [{ kind: "network", value: "10.0.0.0/8" }],
      }),
    (err: Error) => err instanceof TargetRefusedError,
  );
  // Audited as recon_scope_refused (the third-party-scanning guard); range failed.
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].reason, "recon_scope_refused");
  assert.equal(state.ranges[0].state, "failed");
});

test("startLabRun(recon): an invalid scope is a plain validation refusal, NOT audited", async () => {
  // A non-normalisable value is a 400-class validation error, not abuse — mirrors
  // the attest boundary note (nobody was refused a run over an asset they hold).
  await assert.rejects(
    () =>
      startLabRun({
        userId: USER,
        scenarioSlug: RECON_SCENARIO_SLUG,
        targets: [{ kind: "host", value: "not a host!!" }],
      }),
    (err: Error) => err instanceof LabRunRefusedError && err.message.startsWith("recon_scope_invalid"),
  );
  assert.equal(state.reports.length, 0);
  assert.equal(state.ranges[0].state, "failed");
});
