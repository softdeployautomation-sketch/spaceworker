// TASK_156B REAL EGRESS (PLAN_CYBERLAB_REAL_EGRESS.md) — live server-egress scan
// (run: npx tsx --test tests/lab-live-egress.test.ts).
//
// WHAT THIS FILE PROVES:
//   1. validateLiveScope (pure): with the dials at their SHIPPED defaults every
//      normalisable scope is kept (the friction=0 posture — scan-first, no
//      attested device); `not_normalized` is always refused; the OPTIONAL /24
//      breadth guard and CIDR allow-list only bite when their dial is on.
//   2. generateLiveTelemetry (server): an INJECTED fake probe — never a real
//      socket in tests — yields artefacts saying synthetic:false / live:true,
//      records open/closed/filtered per declared host×port, and keeps the HARD
//      LINE (throws on empty scope, empty ports, or an out-of-range port).
//   3. Engine (REAL startLabRun): a `live` scenario with the master dial ON runs
//      to a SIGNED episode (mode "live", completed_live) with NO attested target;
//      with the dial OFF (shipped default) it is refused (live_egress_disabled)
//      and NO range is created, so no packet can escape by accident.
//
// HOW: same house require hook as tests/lab-recon.test.ts — every lib/lab/*
// module is REAL; only the EDGES are faked (in-memory db, mutable admin settings,
// entitlement decision, and node:net's `connect`). Faking `connect` (the OS
// socket) rather than the runner keeps the real netProbe/generateLiveTelemetry
// under test while guaranteeing no packet leaves the test machine.
//
// HONEST LIMIT: proves the egress MACHINERY and its dials — not that any
// particular host is reachable. Real reachability is the operator's own VM,
// tested live once the owner flips the master dial on.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { EventEmitter } from "node:events";

process.env.DATABASE_URL = "postgresql://t156:t156@localhost:5432/task156_placeholder";
process.env.SESSION_SECRET = "task156-test-session-secret";
process.env.RESEND_API_KEY = "task156-test-resend";
process.env.EMAIL_FROM = "t156@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

type Row = Record<string, unknown>;
type ProbeState = "open" | "closed" | "filtered";

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

const USER = "user-live-1";

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
  // REAL EGRESS dials — the master switch ships FALSE; friction guards too.
  cyberlabLiveEgressEnabled: false,
  cyberlabEgressRequireOwnershipProof: false,
  cyberlabEgressScopeGuard: false,
  cyberlabEgressAllowList: "",
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

// ---------------------------------------------------------------------------
// The fake OS edge: node:net `connect`. The REAL netProbe calls connect() and
// listens for 'connect' / 'error'(ECONNREFUSED) / 'timeout'. We reproduce those
// three outcomes from a mutable `probeMap` so the real runner runs but no packet
// ever leaves the test machine. `isIP` (used by live-core) stays the REAL one.
// ---------------------------------------------------------------------------
const probeMap = new Map<string, ProbeState>();
let defaultProbeState: ProbeState = "closed";

interface FakeSocket extends EventEmitter {
  destroy: () => void;
  setTimeout: (ms: number, cb?: () => void) => FakeSocket;
}

function fakeConnect(opts: { host: string; port: number; timeout?: number }): FakeSocket {
  const socket = new EventEmitter() as FakeSocket;
  let onTimeout: (() => void) | null = null;
  socket.destroy = () => {};
  // netProbe registers its timeout as `socket.setTimeout(ms, cb)` and relies on
  // the CALLBACK (not a 'timeout' event) to resolve `filtered`. We store the cb
  // and invoke it on the filtered outcome. It is registered synchronously by
  // netProbe right after connect() returns, i.e. before our microtask runs.
  socket.setTimeout = (_ms: number, cb?: () => void) => {
    if (cb) onTimeout = cb;
    return socket;
  };
  const outcome = probeMap.get(`${opts.host}:${opts.port}`) ?? defaultProbeState;
  queueMicrotask(() => {
    if (outcome === "open") {
      socket.emit("connect");
    } else if (outcome === "closed") {
      const err = new Error("connect ECONNREFUSED") as Error & { code: string };
      err.code = "ECONNREFUSED";
      socket.emit("error", err);
    } else {
      onTimeout?.();
    }
  });
  return socket;
}

// The REAL node:net, captured before the hook installs (so we spread its real
// exports, e.g. isIP, while overriding only `connect`).
/* eslint-disable @typescript-eslint/no-require-imports */
const realNet = require("node:net") as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-require-imports */

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "node:net" || request === "net") return { ...realNet, connect: fakeConnect };
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
const episodeMod = require("../lib/lab/episode") as typeof import("../lib/lab/episode");
const liveCore = require("../lib/lab/live-core") as typeof import("../lib/lab/live-core");
const liveRunner = require("../lib/lab/live-runner") as typeof import("../lib/lab/live-runner");
const scenariosMod = require("../lib/lab/scenarios") as typeof import("../lib/lab/scenarios");
const targetsMod = require("../lib/lab/targets") as typeof import("../lib/lab/targets");
/* eslint-enable @typescript-eslint/no-require-imports */

const { startLabRun, LabRunRefusedError } = engine;
const { TargetRefusedError } = targetsMod;
const { verifyEpisodeSignature } = episodeMod;
const { validateLiveScope, normalizeLivePort, inLiveAllowList, LIVE_TECHNIQUE_IDS } = liveCore;
const { generateLiveTelemetry } = liveRunner;
const { ensureLiveEgressScenario, ensureSmokeScenario, LIVE_EGRESS_SCENARIO_SLUG } = scenariosMod;

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
  adminRow.cyberlabLiveEgressEnabled = false;
  adminRow.cyberlabEgressScopeGuard = false;
  adminRow.cyberlabEgressAllowList = "";
  probeMap.clear();
  defaultProbeState = "closed";
  await ensureSmokeScenario();
  await ensureLiveEgressScenario();
});

// ---------------------------------------------------------------------------
// 1. validateLiveScope / normalizeLivePort / inLiveAllowList (pure)
// ---------------------------------------------------------------------------

test("validateLiveScope: shipped defaults (all dials off) keep every normalisable scope — friction=0", () => {
  const { kept, issues } = validateLiveScope([
    { kind: "host", value: "192.168.10.20" },
    { kind: "host", value: " my-vm.example.test " }, // normalises + trims
    { kind: "network", value: "10.0.0.0/8" }, // broad, but scopeGuard is OFF
    { kind: "network", value: "192.168.10.0/24" },
  ]);
  assert.equal(issues.length, 0);
  assert.deepEqual(
    kept.map((k) => `${k.kind}:${k.value}`),
    ["host:192.168.10.20", "host:my-vm.example.test", "network:10.0.0.0/8", "network:192.168.10.0/24"],
  );
});

test("validateLiveScope: not_normalized is ALWAYS refused; duplicates collapse", () => {
  const { kept, issues } = validateLiveScope([
    { kind: "host", value: "not a host!!" },
    { kind: "host", value: "192.168.10.20" },
    { kind: "host", value: "192.168.10.20" }, // duplicate after normalisation
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].reason, "not_normalized");
  assert.equal(kept.length, 1);
});

test("validateLiveScope: the OPTIONAL scope guard refuses a broad network only when its dial is on", () => {
  const scopeGuardOn = validateLiveScope([{ kind: "network", value: "10.0.0.0/16" }], { scopeGuard: true });
  assert.equal(scopeGuardOn.kept.length, 0);
  assert.equal(scopeGuardOn.issues[0].reason, "too_broad_scope");

  // A /24 passes the guard; the same /16 without the dial is kept.
  const narrow = validateLiveScope([{ kind: "network", value: "192.168.10.0/24" }], { scopeGuard: true });
  assert.equal(narrow.issues.length, 0);
  const guardOff = validateLiveScope([{ kind: "network", value: "10.0.0.0/16" }]);
  assert.equal(guardOff.issues.length, 0);
});

test("validateLiveScope: the OPTIONAL allow-list bites only when non-empty; inLiveAllowList matches host + CIDR", () => {
  // Empty list = allow all.
  assert.equal(validateLiveScope([{ kind: "host", value: "10.9.9.9" }], { allowList: [] }).issues.length, 0);
  // Non-empty list refuses an out-of-list host.
  const refused = validateLiveScope([{ kind: "host", value: "10.9.9.9" }], { allowList: ["192.168.10.0/24", "my-vm.test"] });
  assert.equal(refused.issues[0].reason, "not_in_allow_list");
  // ...and keeps an in-list host (exact) and an in-list CIDR member.
  const kept = validateLiveScope(
    [
      { kind: "host", value: "my-vm.test" },
      { kind: "host", value: "192.168.10.20" }, // inside the allow-listed /24
    ],
    { allowList: ["192.168.10.0/24", "my-vm.test"] },
  );
  assert.equal(kept.issues.length, 0);
  assert.equal(kept.kept.length, 2);
  // inLiveAllowList: exact host (case-insensitive) + base-IP-in-CIDR.
  assert.equal(inLiveAllowList("MY-VM.TEST", ["my-vm.test"]), true);
  assert.equal(inLiveAllowList("192.168.10.20", ["192.168.10.0/24"]), true);
  assert.equal(inLiveAllowList("10.0.0.1", ["192.168.10.0/24"]), false);
});

test("normalizeLivePort: valid ints pass; out-of-range / non-integers are null (never a silent clamp)", () => {
  assert.equal(normalizeLivePort(22), 22);
  assert.equal(normalizeLivePort("443"), 443);
  assert.equal(normalizeLivePort(1), 1);
  assert.equal(normalizeLivePort(65_535), 65_535);
  assert.equal(normalizeLivePort(0), null);
  assert.equal(normalizeLivePort(65_536), null);
  assert.equal(normalizeLivePort(80.5), null);
  assert.equal(normalizeLivePort("ssh"), null);
  assert.equal(normalizeLivePort(undefined), null);
});

// ---------------------------------------------------------------------------
// 2. generateLiveTelemetry (server) — INJECTED probe, never a real socket
// ---------------------------------------------------------------------------

test("generateLiveTelemetry: real runner + injected probe → synthetic:false/live:true, states recorded per host×port", async () => {
  // An injected probe (not the real netProbe): 22 open, 80 closed, 443 filtered.
  const injected = async (_host: string, port: number): Promise<"open" | "closed" | "filtered"> =>
    port === 22 ? "open" : port === 80 ? "closed" : "filtered";

  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const endedAt = new Date("2026-01-01T00:00:05.000Z");
  const tel = await generateLiveTelemetry({
    rangeId: "r-live-1",
    scenarioSlug: LIVE_EGRESS_SCENARIO_SLUG,
    targets: [{ kind: "host", value: "192.168.10.20" }],
    ports: [22, 80, 443],
    startedAt,
    endedAt,
    probe: injected,
  });

  // The three probe states are recorded as real evidence, not synthetic.
  assert.deepEqual(
    tel.results.map((r) => `${r.host}:${r.port}=${r.state}`),
    ["192.168.10.20:22=open", "192.168.10.20:80=closed", "192.168.10.20:443=filtered"],
  );
  // Only the open port counts as a "surface" finding.
  assert.equal(tel.results.filter((r) => r.state === "open").length, 1);
  // Both artefacts are honest that this is a LIVE (not synthetic) run.
  const surface = JSON.parse(tel.artefacts.find((a) => a.path === "surface.json")!.content);
  const detections = JSON.parse(tel.artefacts.find((a) => a.path === "detections.json")!.content);
  assert.equal(surface.synthetic, false);
  assert.equal(surface.live, true);
  assert.equal(detections.synthetic, false);
  assert.equal(detections.live, true);
  assert.equal(detections.openPortCount, 1);
  // Techniques + signatures are the live set, and the timeline carries real
  // per-port events plus the bookend range.created / range.destroyed.
  assert.deepEqual(tel.techniques, [...LIVE_TECHNIQUE_IDS]);
  const events = tel.timeline.map((e) => e.event);
  assert.ok(events.includes("range.created"));
  assert.ok(events.includes("live.port_open"));
  assert.ok(events.includes("live.port_closed"));
  assert.ok(events.includes("live.port_filtered"));
  assert.ok(events.includes("range.destroyed"));
});

test("generateLiveTelemetry: HARD LINE — throws on empty scope, empty ports, or an out-of-range port", async () => {
  const startedAt = new Date();
  const base = { rangeId: "r1", scenarioSlug: LIVE_EGRESS_SCENARIO_SLUG, startedAt, endedAt: startedAt, probe: async () => "closed" as const };
  // No declared target — never scan nothing.
  await assert.rejects(() => generateLiveTelemetry({ ...base, targets: [], ports: [22] }), RangeError);
  // No ports — a sweep with nothing to probe.
  await assert.rejects(() => generateLiveTelemetry({ ...base, targets: [{ kind: "host", value: "10.0.0.5" }], ports: [] }), RangeError);
  // An out-of-range port is a refusal, never a silent clamp.
  await assert.rejects(() => generateLiveTelemetry({ ...base, targets: [{ kind: "host", value: "10.0.0.5" }], ports: [70_000] }), RangeError);
});

test("generateLiveTelemetry: a `network` target probes its own base address (the /24 gateway case)", async () => {
  const seen: string[] = [];
  const record = async (host: string): Promise<"closed"> => {
    seen.push(host);
    return "closed";
  };
  await generateLiveTelemetry({
    rangeId: "r2",
    scenarioSlug: LIVE_EGRESS_SCENARIO_SLUG,
    targets: [{ kind: "network", value: "192.168.10.0/24" }],
    ports: [22],
    startedAt: new Date(),
    endedAt: new Date(),
    probe: record,
  });
  // The probed host is the network's base IP, not the literal "…/24" string.
  assert.deepEqual(seen, ["192.168.10.0"]);
});

// ---------------------------------------------------------------------------
// 3. Engine (REAL startLabRun) — the master dial is the only thing that lets a
//    packet out; the fake `connect` edge guarantees no real socket in tests.
// ---------------------------------------------------------------------------

test("startLabRun(live): dial ON → SIGNED live episode, NO attested target, real open port in surface.json", async () => {
  // The owner flips the master switch on for this test only.
  adminRow.cyberlabLiveEgressEnabled = true;
  // Our fake OS edge reports 192.168.10.20:22 open, :80 closed.
  probeMap.set("192.168.10.20:22", "open");
  probeMap.set("192.168.10.20:80", "closed");

  // NO attestTarget() anywhere — the owner's whole point: a real scan/attack
  // starts from a declared scope, not a pre-attested device.
  assert.equal(state.targets.length, 0);

  const result = await startLabRun({
    userId: USER,
    scenarioSlug: LIVE_EGRESS_SCENARIO_SLUG,
    targets: [{ kind: "host", value: "192.168.10.20" }],
    ports: [22, 80],
  });

  assert.equal(result.mode, "live");
  assert.equal(result.verified, true);
  assert.equal(result.targets.length, 1);
  assert.equal(state.targets.length, 0); // still no attestation row
  assert.deepEqual(result.techniques, [...LIVE_TECHNIQUE_IDS]);
  // The recorded surface carries the REAL open port and is honest it is live.
  const surface = JSON.parse(result.artefacts.find((a) => a.path === "surface.json")!.content);
  assert.equal(surface.synthetic, false);
  assert.equal(surface.live, true);
  assert.deepEqual(surface.openPorts.map((o: { host: string; port: number }) => `${o.host}:${o.port}`), ["192.168.10.20:22"]);
  // Range torn down + verified; episode signature recomputes true; outcome live.
  const range = state.ranges.find((r) => r.id === result.rangeId)!;
  assert.equal(range.state, "torn_down");
  assert.ok(range.teardownVerifiedAt instanceof Date);
  assert.equal(await verifyEpisodeSignature(result.episodeId), true);
  const episode = state.episodes.find((e) => e.id === result.episodeId)!;
  assert.equal(episode.outcome, "completed_live");
});

test("startLabRun(live): dial OFF (shipped default) → refused (live_egress_disabled), NO range created", async () => {
  // beforeEach leaves cyberlabLiveEgressEnabled = false (the ship-dark default).
  await assert.rejects(
    () =>
      startLabRun({
        userId: USER,
        scenarioSlug: LIVE_EGRESS_SCENARIO_SLUG,
        targets: [{ kind: "host", value: "192.168.10.20" }],
        ports: [22],
      }),
    (err: Error) => err instanceof LabRunRefusedError && err.message.startsWith("live_egress_disabled"),
  );
  // Refused before any range is provisioned — no packet could have escaped.
  assert.equal(state.ranges.length, 0);
});

test("startLabRun(live): the scope guard, when the owner arms it, refuses a broad network pre-flight (NOT audited)", async () => {
  adminRow.cyberlabLiveEgressEnabled = true;
  adminRow.cyberlabEgressScopeGuard = true; // owner arms the /24 breadth guard
  await assert.rejects(
    () =>
      startLabRun({
        userId: USER,
        scenarioSlug: LIVE_EGRESS_SCENARIO_SLUG,
        targets: [{ kind: "network", value: "10.0.0.0/8" }],
      }),
    (err: Error) => err instanceof TargetRefusedError,
  );
  // A guard refusal is the owner's friction=0 policy knob, NOT the third-party
  // scanning guard — so it fails the range but writes NO abuse report.
  assert.equal(state.reports.length, 0);
  const range = state.ranges[0];
  assert.equal(range.state, "failed");
});





