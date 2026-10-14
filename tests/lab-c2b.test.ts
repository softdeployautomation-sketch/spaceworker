// TASK_156B C2b (PLAN_TASK_156 §13, BYOT) — the victim-sensor evidence chain
// (run: npx tsx --test tests/lab-c2b.test.ts).
//
// WHAT THIS FILE PROVES (the C2b build-order acceptance list, module level):
//   1. The victim sensor (`collectVictimSensor`) reads the user's OWN devices'
//      agent rows (DeviceHeartbeat / DeviceAudit / DeviceJob / DeviceAction) for
//      exactly the run's window — a device from ANOTHER account is a refusal
//      (§5.2 LabAbuseReport + VictimDeviceRefusedError thrown BEFORE any stream
//      row is read; body-supplied ids are never an ownership oracle).
//   2. An empty result is HONEST: real window totals (counts), capped streams
//      with a `truncated` count, bounds inside the envelope — absence recorded
//      as absence, never invented.
//   3. The full engine chain with `victimDeviceIds`: the envelope joins the
//      SIGNED manifest as `victim/agent-sensor.json`, the stored episode
//      timeline Json carries the same victim object (timeline.json and the
//      stored timeline can never disagree — sensor runs BEFORE artefacts), and
//      the episode's signature recomputes true from the stored row.
//   4. Without victimDeviceIds, C2a behaviour is unchanged (no victim artefact,
//      `victim: null` in the result).
//   5. The §13.2 researched tool rows are in the catalog seed with their
//      licence/derivation/legal-basis fields populated.
//
// HOW: same house require-hook harness as tests/lab-c2.test.ts — the REAL lab
// modules, faked edges only (in-memory db incl. the device* models, admin
// settings row, entitlement decision). Governor stays at its shipped default.
//
// HONEST LIMIT: this proves the sensor's scoping/window/signing mechanics. It
// does NOT prove packet-level capture (tshark/PCAP, owner-host phase) nor that
// a real device agent writes rows with these exact columns — the column shapes
// mirror prisma/schema.prisma Device* models, which the agent contract owns.

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
// In-memory stand-ins for the models the chain touches (lab + device*).
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
  devices: Row[];
  heartbeats: Row[];
  audits: Row[];
  jobs: Row[];
  actions: Row[];
  /** How many stream rows the sensor read — proves "refused before any read". */
  streamReads: number;
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
  devices: [],
  heartbeats: [],
  audits: [],
  jobs: [],
  actions: [],
  streamReads: 0,
};

const USER = "user-lab-1";
const OTHER_USER = "user-lab-2";

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
      if ("lte" in cond) {
        if (!(actual instanceof Date) || actual.getTime() > (cond.lte as Date).getTime()) return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

/** Generic windowed stream fake: count + findMany with asc orderBy + take.
 *  Takes a LAZY accessor — beforeEach reassigns state arrays, so the model
 *  must read through the accessor, never capture the array at module load. */
function streamModel(rows: () => Row[]) {
  return {
    count: async ({ where }: { where: Row }) => {
      state.streamReads += 1;
      return rows().filter((r) => matches(r, where)).length;
    },
    findMany: async ({ where, orderBy, take }: { where: Row; orderBy?: Row; take?: number }) => {
      state.streamReads += 1;
      let out = rows().filter((r) => matches(r, where));
      if (orderBy?.createdAt === "asc") out = [...out].sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());
      if (typeof take === "number") out = out.slice(0, take);
      return out;
    },
  };
}

/** The admin settings row the gates read. Mutated per test. */
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
  device: {
    findMany: async ({ where }: { where: Row }) => state.devices.filter((d) => matches(d, where)),
    // §13.5 — attestTarget's ownership check (owner match, not hosted, not
    // removed). Same `matches` semantics as every other fake in this file.
    findFirst: async ({ where }: { where: Row }) =>
      state.devices.find((d) => matches(d, where)) ?? null,
  },
  deviceHeartbeat: streamModel(() => state.heartbeats),
  deviceAudit: streamModel(() => state.audits),
  deviceJob: streamModel(() => state.jobs),
  deviceAction: streamModel(() => state.actions),
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
const episodeMod = require("../lib/lab/episode") as typeof import("../lib/lab/episode");
const scenariosMod = require("../lib/lab/scenarios") as typeof import("../lib/lab/scenarios");
const victimSensor = require("../lib/lab/victim-sensor") as typeof import("../lib/lab/victim-sensor");
const catalogMod = require("../lib/lab/catalog-seed") as typeof import("../lib/lab/catalog-seed");
/* eslint-enable @typescript-eslint/no-require-imports */

const { startLabRun } = engine;
const { attestTarget } = targetsMod;
const { verifyEpisodeSignature } = episodeMod;
const { ensureSmokeScenario } = scenariosMod;
const {
  collectVictimSensor,
  VictimDeviceRefusedError,
  VICTIM_SENSOR_SCHEMA,
  VICTIM_STREAM_CAP,
  VICTIM_SENSOR_LOOKBACK_MS,
} = victimSensor;
const { CATALOG_SEED } = catalogMod;

const HOST_A = "10.77.0.11";
const HOST_B = "10.77.0.12";
const twoHosts = [
  { kind: "host", value: HOST_A },
  { kind: "host", value: HOST_B },
];

/** Seed one of the caller's own devices (agent-bound by default). */
function seedDevice(overrides: Row = {}): Row {
  const row: Row = {
    id: `dev${++state.seq}`,
    userId: USER,
    name: "victim-vm",
    deviceKind: "mac",
    vantraAgentId: `agent-${state.seq}`,
    osName: "macOS",
    status: "online",
    lastSeenAt: new Date(),
    ...overrides,
  };
  state.devices.push(row);
  return row;
}

/** Seed an in-window agent row on one of the four streams. */
function seedStreamRows(deviceId: string, at: Date, counts: { hb?: number; audit?: number; job?: number; action?: number } = {}): void {
  const n = (x: number | undefined) => x ?? 1;
  for (let i = 0; i < n(counts.hb); i++) state.heartbeats.push({ id: `hb${++state.seq}`, deviceId, agentVersion: "1.4.0", ipAddress: "192.168.1.20", createdAt: at });
  for (let i = 0; i < n(counts.audit); i++) state.audits.push({ id: `au${++state.seq}`, deviceId, actor: "agent", channel: "device", event: "process.started", detail: "{}", createdAt: at });
  for (let i = 0; i < n(counts.job); i++) state.jobs.push({ id: `jb${++state.seq}`, deviceId, jobType: "collect", status: "completed", createdAt: at, finishedAt: at });
  for (let i = 0; i < n(counts.action); i++) state.actions.push({ id: `ac${++state.seq}`, deviceId, actionType: "screenshot", status: "completed", createdAt: at, executedAt: at });
}

beforeEach(() => {
  state.consentSigned = true;
  state.entitled = true;
  state.targets = [];
  state.ranges = [];
  state.scenarios = [];
  state.episodes = [];
  state.reports = [];
  state.devices = [];
  state.heartbeats = [];
  state.audits = [];
  state.jobs = [];
  state.actions = [];
  state.streamReads = 0;
  state.seq = 0;
  adminRow.cyberlabEnabled = true;
  adminRow.governorEnabled = false;
  adminRow.cyberlabMaxEpisodesPerMonth = 20;
});

// ---------------------------------------------------------------------------
// 1. The sensor itself: own-device scoping, window bounds, honest counts.
// ---------------------------------------------------------------------------

test("collectVictimSensor: own device — window-scoped reads, honest counts, victim.sensor timeline entries", async () => {
  const dev = seedDevice();
  const startedAt = new Date();
  const endedAt = new Date(startedAt.getTime() + 60_000);
  // In-window rows.
  seedStreamRows(dev.id as string, new Date(startedAt.getTime() + 10_000), { hb: 2, audit: 1, job: 1, action: 1 });
  // OUT-of-window rows: before the lookback bound, and after endedAt.
  const before = new Date(startedAt.getTime() - VICTIM_SENSOR_LOOKBACK_MS - 60_000);
  const after = new Date(endedAt.getTime() + 60_000);
  seedStreamRows(dev.id as string, before, { hb: 3 });
  seedStreamRows(dev.id as string, after, { hb: 4, audit: 2 });

  const res = await collectVictimSensor({ userId: USER, rangeId: null, deviceIds: [dev.id as string], startedAt, endedAt });

  assert.equal(res.envelope.schema, VICTIM_SENSOR_SCHEMA);
  assert.equal(res.envelope.devices.length, 1);
  assert.equal(res.envelope.devices[0]?.agentBound, true);
  // Honest window totals: ONLY the in-window rows count.
  assert.deepEqual(res.envelope.counts, { heartbeats: 2, audit: 1, jobs: 1, actions: 1 });
  assert.deepEqual(res.envelope.truncated, { heartbeats: 0, audit: 0, jobs: 0, actions: 0 });
  assert.equal(res.envelope.streams.heartbeats.length, 2);
  // Bounds are inside the artefact — the claim is auditable.
  assert.equal(new Date(res.envelope.window.from).getTime(), startedAt.getTime() - VICTIM_SENSOR_LOOKBACK_MS);
  assert.equal(new Date(res.envelope.window.to).getTime(), endedAt.getTime());
  // Timeline entries are the sensor's observations, one per readable device.
  assert.equal(res.timelineEntries.length, 1);
  assert.equal(res.timelineEntries[0]?.event, "victim.sensor");
  assert.equal(res.summary.deviceCount, 1);
});

test("collectVictimSensor: a device owned by ANOTHER user is a §5.2 refusal — report written, NO stream rows read", async () => {
  const foreign = seedDevice({ userId: OTHER_USER });
  // Agent rows exist on the foreign device — they must never be readable.
  seedStreamRows(foreign.id as string, new Date(), { hb: 5, audit: 5 });

  const now = new Date();
  await assert.rejects(
    collectVictimSensor({ userId: USER, rangeId: null, deviceIds: [foreign.id as string], startedAt: now, endedAt: now }),
    (err: Error) =>
      err instanceof VictimDeviceRefusedError && err.missing.length === 1 && err.missing[0] === foreign.id,
  );

  // The §5.2 trail: a report is written before the throw reaches the caller.
  const report = state.reports.find((r) => r.reason === "victim_device_refused");
  assert.ok(report, "LabAbuseReport with reason victim_device_refused must exist");
  assert.equal(report.severity, "medium");
  assert.equal(report.userId, USER);
  // Refused BEFORE any agent stream row was read — body ids are not an oracle.
  assert.equal(state.streamReads, 0);
});

test("collectVictimSensor: empty is honest — zero counts, empty streams, no invented presence", async () => {
  const dev = seedDevice({ vantraAgentId: null, status: "offline", lastSeenAt: null });
  const now = new Date();

  const res = await collectVictimSensor({ userId: USER, rangeId: null, deviceIds: [dev.id as string], startedAt: now, endedAt: now });

  assert.deepEqual(res.envelope.counts, { heartbeats: 0, audit: 0, jobs: 0, actions: 0 });
  assert.deepEqual(res.envelope.streams, { heartbeats: [], audit: [], jobs: [], actions: [] });
  assert.equal(res.envelope.devices[0]?.agentBound, false, "unbound agent is recorded as unbound");
  assert.equal(res.envelope.devices[0]?.lastSeenAt, null);
  assert.equal(res.timelineEntries.length, 1, "the observation is still recorded — absence is evidence too");
});

test("collectVictimSensor: streams are capped with an honest truncated count — counts still tell the truth", async () => {
  const dev = seedDevice();
  const startedAt = new Date();
  const endedAt = new Date(startedAt.getTime() + 1_000);
  // CAP + 5 in-window rows: the manifest gets a bounded artefact…
  const base = new Date(startedAt.getTime() + 100);
  for (let i = 0; i < VICTIM_STREAM_CAP + 5; i++) {
    state.heartbeats.push({ id: `hb${++state.seq}`, deviceId: dev.id, agentVersion: "1.4.0", ipAddress: "192.168.1.20", createdAt: base });
  }

  const res = await collectVictimSensor({ userId: USER, rangeId: null, deviceIds: [dev.id as string], startedAt, endedAt });

  assert.equal(res.envelope.counts.heartbeats, VICTIM_STREAM_CAP + 5, "counts are the true window totals");
  assert.equal(res.envelope.streams.heartbeats.length, VICTIM_STREAM_CAP, "streams stay bounded");
  assert.equal(res.envelope.truncated.heartbeats, 5, "the cut is declared, not silently swallowed");
});

// ---------------------------------------------------------------------------
// 2. The engine chain: victim evidence joins the SIGNED manifest.
// ---------------------------------------------------------------------------

test("startLabRun with victimDeviceIds: victim/agent-sensor.json joins the manifest, timeline agrees, signature verifies", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  const dev = seedDevice();
  // Agent rows land inside the sensor window ([startedAt − 15min, endedAt],
  // and the engine sets startedAt ≈ endedAt ≈ now — so "now" qualifies).
  seedStreamRows(dev.id as string, new Date(), { hb: 3, audit: 2, job: 1, action: 1 });

  const res = await startLabRun({ userId: USER, targets: twoHosts, victimDeviceIds: [dev.id as string] });

  // The run summary reports the victim side.
  assert.ok(res.victim, "victim summary must be present when devices were requested");
  assert.equal(res.victim.deviceCount, 1);
  assert.equal(res.victim.counts.heartbeats, 3);

  // The envelope is a manifest artefact (same bytes the signature covers).
  const victimArtefact = res.artefacts.find((a) => a.path === "victim/agent-sensor.json");
  assert.ok(victimArtefact, "victim/agent-sensor.json must be in the manifest");
  const envelope = JSON.parse(victimArtefact.content) as { schema: string; counts: { heartbeats: number } };
  assert.equal(envelope.schema, VICTIM_SENSOR_SCHEMA);
  assert.equal(envelope.counts.heartbeats, 3);

  // timeline.json (the artefact) carries the sensor observations…
  const timelineArtefact = res.artefacts.find((a) => a.path === "timeline.json");
  const tl = JSON.parse(timelineArtefact?.content ?? "{}") as { entries: Array<{ event: string }> };
  assert.ok(tl.entries.some((e) => e.event === "victim.sensor"), "artefact timeline must include victim.sensor");
  // …and the stored episode timeline Json carries the SAME entries + envelope
  // (collected BEFORE artefacts precisely so these can never disagree).
  const ep = state.episodes.find((e) => e.id === res.episodeId);
  assert.ok(ep, "episode row must exist");
  const stored = ep.timeline as { entries: Array<{ event: string }>; victim?: { schema: string } };
  assert.ok(stored.entries.some((e) => e.event === "victim.sensor"), "stored timeline must include victim.sensor");
  assert.equal(stored.victim?.schema, VICTIM_SENSOR_SCHEMA, "victim envelope stored inside the timeline Json");

  // Signed, verifiable, terminal.
  assert.equal(await verifyEpisodeSignature(res.episodeId), true);
  const range = state.ranges.find((r) => r.id === res.rangeId);
  assert.equal(range?.state, "torn_down");
  assert.ok(range?.teardownVerifiedAt instanceof Date);
});

test("startLabRun WITHOUT victimDeviceIds: C2a behaviour unchanged — no victim artefact, victim null", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  seedDevice(); // devices exist, but none were requested — the sensor never runs.

  const res = await startLabRun({ userId: USER, targets: twoHosts });

  assert.equal(res.victim, null);
  assert.equal(res.artefacts.some((a) => a.path === "victim/agent-sensor.json"), false, "no victim artefact when nothing was requested");
  const ep = state.episodes.find((e) => e.id === res.episodeId);
  assert.ok(ep, "episode row must exist");
  const stored = ep.timeline as { victim?: unknown };
  assert.equal(stored.victim, undefined, "no victim key stored when the sensor did not run");
  assert.equal(await verifyEpisodeSignature(res.episodeId), true);
});

test("startLabRun with a FOREIGN victim device: refusal fails the range — no dangling live state, report written", async () => {
  await ensureSmokeScenario();
  await attestTarget({ userId: USER, kind: "host", value: HOST_A });
  await attestTarget({ userId: USER, kind: "host", value: HOST_B });
  const foreign = seedDevice({ userId: OTHER_USER });
  seedStreamRows(foreign.id as string, new Date(), { hb: 9 });

  await assert.rejects(
    startLabRun({ userId: USER, targets: twoHosts, victimDeviceIds: [foreign.id as string] }),
    (err: Error) => err instanceof VictimDeviceRefusedError,
  );

  // The hard line: the refused attempt lands `failed`, never a live dangling range.
  assert.equal(state.ranges.length, 1, "the range row exists (created before the refusal)");
  assert.equal(state.ranges[0]?.state, "failed");
  assert.equal(state.reports.some((r) => r.reason === "victim_device_refused"), true, "§5.2 report written");
  // And no episode was minted for a refused run.
  assert.equal(state.episodes.length, 0);
  // No stream rows were read past the ownership check.
  assert.equal(state.streamReads, 0);
});

// ---------------------------------------------------------------------------
// 3. The researched §13.2 tool rows are in the catalog seed.
// ---------------------------------------------------------------------------

test("CATALOG_SEED: the §13.2 researched tool rows exist with licence + derivation + legal basis", () => {
  const researched = ["tshark", "wireshark", "burp-suite-community", "owasp-zap", "nessus-essentials", "abuseipdb", "virustotal"];
  const slugs = CATALOG_SEED.map((r) => r.slug);
  for (const slug of researched) {
    const row = CATALOG_SEED.find((r) => r.slug === slug);
    assert.ok(row, `catalog row ${slug} must exist`);
    assert.ok((row.licence ?? "").length > 0, `${slug} must state its licence`);
    assert.ok((row.derivation ?? "").length > 0, `${slug} must state its real-world derivation`);
    assert.ok((row.legalBasis ?? "").length > 0, `${slug} must state its legal basis`);
  }
  // The VirusTotal free-tier caveat is contractual, not cosmetic — it must be recorded.
  const vt = CATALOG_SEED.find((r) => r.slug === "virustotal");
  assert.match(vt?.legalBasis ?? "", /BYO/, "VirusTotal row must carry the BYO-key terms caveat");
  // No duplicate slugs after the addition.
  assert.equal(new Set(slugs).size, slugs.length, "duplicate slugs");
});

// ---------------------------------------------------------------------------
// 4. PLAN §13.5 — device-linked attestation ("pick from your devices").
//    The client's sourceDeviceId is NEVER trusted: it must be this user's own
//    live workstation (the devices-tab filter, enforced server-side), or the
//    attest is a plain validation error with NO row written.
// ---------------------------------------------------------------------------

test("attestTarget with the user's OWN device — value normalised, sourceDeviceId link stored", async () => {
  state.devices.push({ id: "dev-own", userId: USER, deviceKind: "workstation", removedAt: null, name: "Win-PC" });
  const row = await targetsMod.attestTarget({
    userId: USER,
    kind: "host",
    value: "203.0.113.7",
    sourceDeviceId: "dev-own",
  });
  assert.equal(row.sourceDeviceId, "dev-own");
  assert.equal(row.value, "203.0.113.7");
  assert.equal(state.targets.length, 1);
});

test("attestTarget with a device owned by ANOTHER user — validation error, NO row written", async () => {
  state.devices.push({ id: "dev-foreign", userId: OTHER_USER, deviceKind: "workstation", removedAt: null });
  await assert.rejects(
    () =>
      targetsMod.attestTarget({ userId: USER, kind: "host", value: "203.0.113.8", sourceDeviceId: "dev-foreign" }),
    /invalid_source_device/,
    "a foreign device id must never be accepted (and never become an ownership oracle)",
  );
  assert.equal(state.targets.length, 0);
});

test("attestTarget: hosted or removed devices are rejected — the devices-tab filter is enforced", async () => {
  state.devices.push({ id: "dev-hosted", userId: USER, deviceKind: "hosted", removedAt: null });
  state.devices.push({ id: "dev-gone", userId: USER, deviceKind: "workstation", removedAt: new Date() });
  await assert.rejects(
    () => targetsMod.attestTarget({ userId: USER, kind: "host", value: "203.0.113.9", sourceDeviceId: "dev-hosted" }),
    /invalid_source_device/,
  );
  await assert.rejects(
    () => targetsMod.attestTarget({ userId: USER, kind: "host", value: "203.0.113.10", sourceDeviceId: "dev-gone" }),
    /invalid_source_device/,
  );
  assert.equal(state.targets.length, 0);
});

test("attestTarget without a device — hand-typed target still works, link null (BYOT allows non-device targets)", async () => {
  const row = await targetsMod.attestTarget({
    userId: USER,
    kind: "url",
    value: "https://staging.example.com",
  });
  assert.equal(row.sourceDeviceId, null);
  assert.equal(row.kind, "url");
  assert.equal(state.targets.length, 1);
});

