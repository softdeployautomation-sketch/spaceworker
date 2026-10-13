// TASK_156 C2a — the Cyber Lab dry-run chain, end to end (run:
// npx tsx --test tests/lab-c2.test.ts).
//
// WHAT THIS FILE PROVES (the C2a acceptance list, minus the owner-run gates):
//   1. The WHOLE chain works: §12.9 gate (enabled + entitlement + current-AUP
//      consent) → enabled-scenario allow-list → daily/target caps → governor
//      slot ("labRanges") → pre-flight against FRESH attested LabTarget rows →
//      range lifecycle with hard TTL → synthetic smoke telemetry (guarded so it
//      can only mention attested targets) → SIGNED append-only LabEpisode →
//      VERIFIED teardown. The range ends torn_down with teardownVerifiedAt set;
//      the episode's signature recomputes true from the stored row.
//   2. Every refusal is a hard, machine-readable refusal: disabled switch,
//      missing consent, missing entitlement, unattested target (with the
//      §5.2 LabAbuseReport written), stale attestation, per-user range cap,
//      monthly episode cap — and a refused run NEVER leaves a range dangling
//      in a live state (it lands in `failed`).
//   3. Evidence tamper-evidence: editing the stored manifest invalidates the
//      signature (verify → false), and range transitions are forward-only —
//      an illegal move throws, an UNVERIFIED teardown fails the range instead
//      of faking `teardownVerifiedAt`.
//
// HOW: every module under test is the REAL lib/lab/* + lib/resource-governor.ts,
// loaded through the house require hook (HOW_WE_MOVE_FAST §4). Only the edges
// are faked: db (in-memory rows), admin settings (a mutable row), and the
// entitlement decision. Governor stays at its shipped default (OFF) — with
// enforceWhenDisabled: false only the per-user cap applies, exactly as
// production would behave today.
//
// HONEST LIMIT: this proves the machinery on synthetic telemetry. It does NOT
// prove live execution against real lab hosts (C2b, owner infra), nor that the
// AdminSetting rows exist on the live DB (owner-run `npx prisma db push`).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

process.env.DATABASE_URL = "postgresql://t156:t156@localhost:5432/task156_placeholder";
process.env.SESSION_SECRET = "task156-test-session-secret";
process.env.RESEND_API_KEY = "task156-test-resend";
process.env.EMAIL_FROM = "t156@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

// ---------------------------------------------------------------------------
// In-memory stand-ins for the models the chain touches.
// ---------------------------------------------------------------------------

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

const USER = "user-lab-1";

/** Prisma-ish subset match for the where shapes the lab chain uses. */
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

/** The admin settings row the gates read. Mutated per test. */
const adminRow: Row = {
  governorEnabled: false, // the shipped default: governor OFF.
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
      const row: Row = {
        id: `ab${++state.seq}`,
        rangeId: null,
        evidenceJson: null,
        severity: "low",
        status: "open",
        createdAt: new Date(),
        ...data,
      };
      state.reports.push(row);
      return row;
    },
  },
};

// ---------------------------------------------------------------------------
// Require hook: only the EDGES are faked; every lab module is the real one.
// ---------------------------------------------------------------------------

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "@/lib/db") return { db: fakeDb };
    if (request === "@/lib/admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
    if (request === "@/lib/entitlements") {
      return {
        hasEntitlement: async () =>
          state.entitled ? { allowed: true, reason: "premium" } : { allowed: false, reason: "none" },
      };
    }
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/resource-governor.ts")) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({ ...adminRow }) };
      if (request === "./entitlements") {
        return { listEffectiveEntitlements: async () => ({ keys: [], premium: false, grants: [] }) };
      }
      if (request === "./devices") return { recordAgentActionAudit: async () => {} };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const engine = require("../lib/lab/engine") as typeof import("../lib/lab/engine");
const targetsMod = require("../lib/lab/targets") as typeof import("../lib/lab/targets");
const rangeMod = require("../lib/lab/range") as typeof import("../lib/lab/range");
const episodeMod = require("../lib/lab/episode") as typeof import("../lib/lab/episode");
const runnerMod = require("../lib/lab/runner") as typeof import("../lib/lab/runner");
const coreMod = require("../lib/lab/targets-core") as typeof import("../lib/lab/targets-core");
const scenariosMod = require("../lib/lab/scenarios") as typeof import("../lib/lab/scenarios");
/* eslint-enable @typescript-eslint/no-require-imports */

const { startLabRun, LabRunRefusedError } = engine;
const { attestTarget, TargetRefusedError } = targetsMod;
const { verifyEpisodeSignature, assertEpisodeBudget, EpisodeCapError } = episodeMod;
const {
  createLabRange,
  transitionRange,
  provisionRange,
  activateRange,
  beginTeardown,
  completeTeardown,
  RangeTransitionError,
} = rangeMod;
const { generateSmokeTelemetry, SMOKE_TECHNIQUE_IDS, SMOKE_SIGNATURE_IDS } = runnerMod;
const { normalizeTarget, preflightTargets, ipInCidr, LAB_ATTESTATION_MAX_AGE_DAYS } = coreMod;
const { ensureSmokeScenario, SMOKE_SCENARIO_SLUG } = scenariosMod;

const HOST_A = "10.77.0.11";
const HOST_B = "10.77.0.12";
const twoHosts = [
  { kind: "host", value: HOST_A },
  { kind: "host", value: HOST_B },
];

beforeEach(() => {
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
});

// ---------------------------------------------------------------------------
// 1. The happy path: the WHOLE chain, ending in a signed episode + torn_down.
// ---------------------------------------------------------------------------

test("startLabRun: gate → slot → preflight → range → telemetry → signed episode → verified teardown", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });

  const res = await startLabRun({ userId: USER, targets: twoHosts });

  assert.equal(res.mode, "dry-run");
  assert.equal(res.verified, true);
  assert.equal(res.scenarioSlug, SMOKE_SCENARIO_SLUG);
  assert.deepEqual(
    res.targets.map((t) => t.value).sort(),
    [HOST_A, HOST_B].sort(),
  );
  assert.deepEqual(res.techniques, [...SMOKE_TECHNIQUE_IDS]);
  assert.deepEqual(res.telemetrySignatures, [...SMOKE_SIGNATURE_IDS]);
  assert.equal(typeof res.signedHash, "string");
  assert.equal((res.signedHash ?? "").length, 64);

  // Artefact set: the three synthetic telemetry files + the timeline.
  const paths = res.artefacts.map((a) => a.path).sort();
  assert.deepEqual(paths, ["detections.json", "flows.json", "hosts.json", "timeline.json"]);
  const hosts = JSON.parse(res.artefacts.find((a) => a.path === "hosts.json")?.content ?? "{}") as {
    synthetic?: boolean;
    hosts?: { ip: string }[];
  };
  assert.equal(hosts.synthetic, true, "artefacts must be self-describing synthetic");
  assert.deepEqual(
    hosts.hosts?.map((h) => h.ip).sort(),
    [HOST_A, HOST_B].sort(),
  );

  // The range is fully terminal: torn_down with a VERIFIED teardown stamp.
  const range = state.ranges.find((r) => r.id === res.rangeId);
  assert.ok(range, "range row must exist");
  assert.equal(range.state, "torn_down");
  assert.ok(range.teardownVerifiedAt instanceof Date, "verified teardown must be stamped");
  assert.equal(range.error, null);

  // The episode row verifies from its own stored contents (no app trust).
  const ep = state.episodes.find((e) => e.id === res.episodeId);
  assert.ok(ep, "episode row must exist");
  assert.equal(ep.outcome, "completed_dry_run");
  assert.equal(await verifyEpisodeSignature(res.episodeId), true);
});

// ---------------------------------------------------------------------------
// 2. Refusals are hard, machine-readable, and leave no dangling live range.
// ---------------------------------------------------------------------------

test("gate closed: master switch OFF refuses before anything else happens", async () => {
  adminRow.cyberlabEnabled = false;
  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) => err instanceof LabRunRefusedError && /lab_gate_closed \(disabled\)/.test(err.message),
  );
  assert.equal(state.ranges.length, 0, "no range row may be created when the gate is closed");
});

test("gate closed: missing current-AUP consent refuses with consent_missing", async () => {
  state.consentSigned = false;
  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) => err instanceof LabRunRefusedError && /lab_gate_closed \(consent_missing\)/.test(err.message),
  );
  assert.equal(state.ranges.length, 0);
});

test("gate closed: missing cyberlab entitlement refuses with not_entitled", async () => {
  state.entitled = false;
  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) => err instanceof LabRunRefusedError && /lab_gate_closed \(not_entitled\)/.test(err.message),
  );
  assert.equal(state.ranges.length, 0);
});

test("unattested target: TargetRefusedError + LabAbuseReport written + range lands failed", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  // HOST_B is NOT attested — the §5.2 line: a run may only touch attested rows.

  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) =>
      err instanceof TargetRefusedError && /unattested/.test(err.message) && err.issues.length === 1,
  );

  // The refusal is AUDITED (§5.2), not a silent 403.
  assert.equal(state.reports.length, 1);
  const report = state.reports[0];
  assert.equal(report.reason, "preflight_target_refused");
  assert.equal(report.severity, "medium");
  const evidence = report.evidenceJson as { pruned: { value: string; reason: string }[] };
  assert.equal(evidence.pruned[0].value, HOST_B);
  assert.equal(evidence.pruned[0].reason, "unattested");

  // And the range does not dangle in a live state.
  const range = state.ranges.find((r) => typeof r.error === "string" && r.error.includes("unattested"));
  assert.ok(range, "the refused range must carry the error");
  assert.equal(range.state, "failed");
});

test("stale attestation (>90d) is refused as stale_attestation", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  const staleDays = LAB_ATTESTATION_MAX_AGE_DAYS + 1;
  for (const t of state.targets) t.attestedAt = new Date(Date.now() - staleDays * 86_400_000);

  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) => err instanceof TargetRefusedError && /stale_attestation/.test(err.message),
  );
  const evidence = state.reports[0].evidenceJson as { pruned: { reason: string }[] };
  assert.equal(evidence.pruned[0].reason, "stale_attestation");
});

test("per-user range cap: a second concurrent range is refused via the ONE governor", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  // One live (slot-holding) range already exists — the cap is 1 by default.
  state.ranges.push({
    id: "r-live",
    userId: USER,
    state: "active",
    createdAt: new Date(),
    ttlExpiresAt: null,
    teardownVerifiedAt: null,
    error: null,
  });

  // With the governor at its shipped default (OFF), a per-user-cap miss is a
  // QUEUED decision (blocked() returns status "queued", position 0) — the
  // engine surfaces that as lab_range_capacity.
  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) => err instanceof LabRunRefusedError && /lab_range_capacity/.test(err.message),
  );
  const refused = state.ranges.find(
    (r) => typeof r.error === "string" && r.error.includes("lab_range_capacity"),
  );
  assert.ok(refused, "the refused range must carry the governor's reason");
  assert.equal(refused.state, "failed");
});

test("monthly episode cap: assertEpisodeBudget refuses before any episode is written", async () => {
  adminRow.cyberlabMaxEpisodesPerMonth = 1;
  state.episodes.push({ id: "ep-already", userId: USER, createdAt: new Date() });
  await assert.rejects(assertEpisodeBudget(USER), (err: Error) => err instanceof EpisodeCapError);
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts }),
    (err: Error) => err instanceof EpisodeCapError,
  );
  const range = state.ranges[0];
  assert.ok(range, "the range was created before the episode step");
  assert.equal(range.state, "failed", "an episode-cap refusal must fail the range, not dangle it");
});

// ---------------------------------------------------------------------------
// 3. Evidence tamper-evidence + the range state machine's hardness.
// ---------------------------------------------------------------------------

test("tampering with the stored manifest invalidates the episode signature", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  const res = await startLabRun({ userId: USER, targets: twoHosts });
  assert.equal(await verifyEpisodeSignature(res.episodeId), true);

  const ep = state.episodes.find((e) => e.id === res.episodeId);
  assert.ok(ep);
  const manifest = ep.evidenceManifest as { artefactCount: number };
  ep.evidenceManifest = { ...manifest, artefactCount: 99 } as unknown;
  assert.equal(await verifyEpisodeSignature(res.episodeId), false, "edited row must fail verification");
});

test("range transitions are forward-only; unverified teardown FAILS the range, never fakes the stamp", async () => {
  const range = await createLabRange({ userId: USER, scenarioId: "s1", consentId: null });

  // pending → active skips provisioning: refused.
  await assert.rejects(transitionRange(range.id, "active"), (err: Error) => err instanceof RangeTransitionError);

  await provisionRange(range.id);
  const activated = await activateRange(range.id, 30);
  assert.ok(activated.ttlExpiresAt instanceof Date, "activation must stamp the hard TTL");

  await beginTeardown(range.id);
  // An UNVERIFIED teardown must never reach torn_down: it fails + throws.
  await assert.rejects(completeTeardown(range.id, false), (err: Error) => err instanceof RangeTransitionError);
  const failed = state.ranges.find((r) => r.id === range.id);
  assert.ok(failed);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "teardown_unverified");
  assert.equal(failed.teardownVerifiedAt, null, "the verified-stamp must NOT be set by a failed teardown");

  // Terminal states are terminal.
  await assert.rejects(transitionRange(range.id, "torn_down"), (err: Error) => err instanceof RangeTransitionError);
});

// ---------------------------------------------------------------------------
// 4. PURE pre-flight core + the runner's attested-targets guard.
// ---------------------------------------------------------------------------

test("normalizeTarget: canonical form for all five kinds, refusal for invalid values", () => {
  assert.deepEqual(normalizeTarget("host", `  ${HOST_A}  `), { kind: "host", value: HOST_A });
  assert.deepEqual(normalizeTarget("host", "[FD00::1]"), { kind: "host", value: "fd00::1" });
  assert.deepEqual(normalizeTarget("network", "10.0.0.0/8"), { kind: "network", value: "10.0.0.0/8" });
  assert.deepEqual(normalizeTarget("email", "A@B.COM"), { kind: "email", value: "a@b.com" });
  assert.equal(normalizeTarget("domain", "Example.COM.")?.value, "example.com");
  assert.notEqual(normalizeTarget("url", "https://Example.com/Path"), null);

  assert.equal(normalizeTarget("host", "not a host!!"), null);
  assert.equal(normalizeTarget("network", "10.0.0.0/33"), null, "v4 prefix > 32");
  assert.equal(normalizeTarget("network", "fd00::/129"), null, "v6 prefix > 128");
  assert.equal(normalizeTarget("network", "10.0.0.0"), null, "missing prefix");
  assert.equal(normalizeTarget("email", "not-an-email"), null);
  assert.equal(normalizeTarget("bogus", "10.0.0.1"), null, "unknown kind");
});

test("ipInCidr: v4/v6 edges (/0, /32, mixed families)", () => {
  assert.equal(ipInCidr("10.255.255.254", "10.0.0.0/8"), true);
  assert.equal(ipInCidr("11.0.0.1", "10.0.0.0/8"), false);
  assert.equal(ipInCidr("10.0.0.1", "10.0.0.1/32"), true);
  assert.equal(ipInCidr("10.0.0.2", "10.0.0.1/32"), false);
  assert.equal(ipInCidr("1.2.3.4", "0.0.0.0/0"), true, "/0 matches everything in family");
  assert.equal(ipInCidr("fd00::1", "fd00::/8"), true);
  assert.equal(ipInCidr("fd00:1::1", "fd00::/16"), true);
  assert.equal(ipInCidr("fe00::1", "fd00::/8"), false);
  assert.equal(ipInCidr("fd00::1", "10.0.0.0/8"), false, "mixed families never match");
  assert.equal(ipInCidr("10.0.0.1", "fd00::/8"), false);
  assert.equal(ipInCidr("not-an-ip", "10.0.0.0/8"), false);
});

test("preflightTargets: unattested / stale / range-mismatch / not-normalised pruned; duplicates collapse", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const fresh = { kind: "host", value: HOST_A, rangeId: null, attestedAt: new Date("2026-10-01T00:00:00Z") };
  const stale = { kind: "host", value: HOST_B, rangeId: null, attestedAt: new Date("2026-01-01T00:00:00Z") };
  const bound = {
    kind: "network",
    value: "10.0.0.0/8",
    rangeId: "r-other",
    attestedAt: new Date("2026-10-01T00:00:00Z"),
  };

  const { kept, pruned } = preflightTargets(
    [fresh, stale, bound],
    [
      { kind: "host", value: HOST_A },
      { kind: "host", value: ` ${HOST_A} ` }, // duplicate after normalisation
      { kind: "host", value: HOST_B },
      { kind: "host", value: "9.9.9.9" },
      { kind: "network", value: "10.0.0.0/8" },
      { kind: "host", value: "not a host!!" },
    ],
    { rangeId: "r-run", now },
  );

  assert.deepEqual(kept, [{ kind: "host", value: HOST_A }]);
  const reasons = Object.fromEntries(pruned.map((p) => [p.value, p.reason]));
  assert.equal(reasons[HOST_B], "stale_attestation");
  assert.equal(reasons["9.9.9.9"], "unattested");
  assert.equal(reasons["10.0.0.0/8"], "range_mismatch");
  assert.equal(reasons["not a host!!"], "not_normalized");
});

test("generateSmokeTelemetry: refuses to run without two attested targets", () => {
  const base = { rangeId: "r1", scenarioSlug: SMOKE_SCENARIO_SLUG, startedAt: new Date(), endedAt: new Date() };
  assert.throws(
    () => generateSmokeTelemetry({ ...base, targets: [HOST_A] }),
    (err: Error) => err instanceof RangeError,
  );
  assert.throws(
    () => generateSmokeTelemetry({ ...base, targets: [] }),
    (err: Error) => err instanceof RangeError,
  );
  const smoke = generateSmokeTelemetry({ ...base, targets: [HOST_A, HOST_B] });
  assert.equal(smoke.artefacts.length, 3);
  assert.deepEqual(smoke.techniques, [...SMOKE_TECHNIQUE_IDS]);
});
