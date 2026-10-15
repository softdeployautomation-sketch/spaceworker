// TASK_156B UI-1 (PLAN_CYBERLAB_STANDALONE_UI.md §3 S2/S3, §5 hard line) — the
// Operation Console's two new guarantees, plus the copy that sells honesty.
// (run: npx tsx --test tests/lab-ui1.test.ts)
//
// WHAT THIS FILE PROVES:
//   A. The pure event→visual map (lib/lab/console-map.ts) obeys the hard line:
//      nodes come ONLY from attested targets; arcs only when BOTH endpoints are
//      attested (a half-known pair draws nothing and is RECORDED as ignored); a
//      detail mentioning an unknown address can never create a node; detection
//      pulses only at attested nodes; ring/angle are LAYOUT, never a measurement.
//   B. The SSE stream route (app/api/cyberlab/runs/[id]/stream) is owner-scoped
//      (a foreign range id is a 404 — never an oracle), reports live:false (the
//      honest REPLAY label), and recomputes signatureValid from the STORED
//      episode row server-side (null when the run never signed) — the client
//      never supplies or trusts validity.
//   C. The section copy keeps the promise: the SIMULATION · YOUR EQUIPMENT
//      watermark is present, /cyberlab is a session-gated top-level route with
//      its own .lab-ops theme, the dashboard keeps a launcher, and the old
//      in-dashboard console component is gone.
//
// HOW: same house require-hook harness as tests/lab-c2b.test.ts — the REAL
// console-map + REAL stream route, faked edges only (next/server, db, session,
// module-gate, episode verifier). The route is loaded through its real relative
// path; its `@/…` imports are intercepted so no alias resolution or network is
// needed.
//
// HONEST LIMIT: this proves the mapping + transport + copy mechanics, not live
// async execution (C2a engine is synchronous today — see the route header) nor
// that a real React client renders the frames (UI rendering is eyeballed live).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONSOLE_MAP_PATH = fileURLToPath(new URL("../lib/lab/console-map.ts", import.meta.url));

process.env.DATABASE_URL = "postgresql://t156:t156@localhost:5432/task156_placeholder";
process.env.SESSION_SECRET = "task156-test-session-secret";
(process.env as Record<string, string>).NODE_ENV = "test";

const USER = "user-ui1-1";
const OTHER = "user-ui1-2";

type Row = Record<string, unknown>;

interface State {
  currentUser: { id: string } | null;
  moduleDenied: unknown;
  ranges: Row[];
  episodes: Row[];
  verifyResult: boolean;
  verifyCalls: string[];
}

const state: State = {
  currentUser: { id: USER },
  moduleDenied: null,
  ranges: [],
  episodes: [],
  verifyResult: true,
  verifyCalls: [],
};

// next/server stub: a constructable class with a static .json(), capturing the
// stream body + headers so the test can read the SSE frames back.
class FakeNextResponse {
  body: ReadableStream<Uint8Array> | null;
  headers: Record<string, string>;
  status: number;
  json: unknown;
  isJson: boolean;
  constructor(body?: ReadableStream<Uint8Array> | null, init?: { headers?: Record<string, string>; status?: number }) {
    this.body = body ?? null;
    this.headers = init?.headers ?? {};
    this.status = init?.status ?? 200;
    this.json = null;
    this.isJson = false;
  }
  static json(obj: unknown, init?: { status?: number }) {
    const r = new FakeNextResponse(null, { status: init?.status ?? 200 });
    r.json = obj;
    r.isJson = true;
    return r;
  }
}

const fakeDb = {
  labRange: {
    findFirst: async ({ where }: { where: Row }) =>
      state.ranges.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
  },
  labEpisode: {
    findFirst: async ({ where }: { where: Row }) =>
      state.episodes.find((e) => e.rangeId === where.rangeId && e.userId === where.userId) ?? null,
  },
};

type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "next/server") return { NextResponse: FakeNextResponse };
    if (request === "@/lib/db") return { db: fakeDb };
    if (request === "@/lib/session-user") return { getCurrentUser: async () => state.currentUser };
    if (request === "@/lib/module-gate") return { moduleToolsDenied: async () => state.moduleDenied };
    if (request === "@/lib/lab/episode") {
      return {
        verifyEpisodeSignature: async (id: string) => {
          state.verifyCalls.push(id);
          return state.verifyResult;
        },
      };
    }
    if (request === "@/lib/lab/console-map") return original.call(this, CONSOLE_MAP_PATH, parent, isMain);
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const mapMod = require("../lib/lab/console-map") as typeof import("../lib/lab/console-map");
const streamRoute = require("../app/api/cyberlab/runs/[id]/stream/route") as typeof import("../app/api/cyberlab/runs/[id]/stream/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const { mapEventToStage, stagesHit, activeStage, buildRadarModel, targetsFromTimeline } = mapMod;

/** Read every SSE frame out of a stream response as parsed objects. */
async function readFrames(res: { body: ReadableStream<Uint8Array> | null }): Promise<Array<Row>> {
  assert.ok(res.body, "expected a stream body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  text += dec.decode();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("data:"))
    .map((b) => JSON.parse(b.slice(b.indexOf(":") + 1).trim()) as Row);
}

function callStream(id: string) {
  return streamRoute.GET(new Request("http://test/stream"), { params: Promise.resolve({ id }) });
}

const TL = {
  mode: "dry-run",
  scenarioSlug: "smoke",
  entries: [
    { at: "2026-10-14T10:00:00.000Z", event: "range.created", detail: { rangeId: "range-1", mode: "dry-run" } },
    { at: "2026-10-14T10:00:01.000Z", event: "telemetry.synthetic_probe_burst", detail: { from: "10.77.0.11", to: "10.77.0.12" } },
    { at: "2026-10-14T10:00:02.000Z", event: "detection.synthetic_trip", detail: {} },
    { at: "2026-10-14T10:00:04.000Z", event: "range.destroyed", detail: { rangeId: "range-1", verified: true } },
  ],
};

beforeEach(() => {
  state.currentUser = { id: USER };
  state.moduleDenied = null;
  state.verifyResult = true;
  state.verifyCalls = [];
  state.ranges = [{ id: "range-1", userId: USER, state: "torn_down", teardownVerifiedAt: new Date("2026-10-14T10:00:04.000Z") }];
  state.episodes = [
    {
      id: "ep-1",
      rangeId: "range-1",
      userId: USER,
      startedAt: new Date("2026-10-14T10:00:00.000Z"),
      outcome: "defended",
      techniques: ["T1046"],
      telemetrySignatures: ["lab.smoke.network_service_scan_burst"],
      signedHash: "deadbeef",
      timeline: TL,
      evidenceManifest: { entries: [{ path: "hosts.json", sha256: "deadbeef", bytes: 123 }] },
    },
  ];
});

// ===========================================================================
// A. The pure event→visual map (the §5 hard line)
// ===========================================================================

test("mapEventToStage routes every engine event onto one rail stage; unknowns land on recon (visible, not dropped)", () => {
  assert.equal(mapEventToStage("range.created"), "arming");
  assert.equal(mapEventToStage("range.destroyed"), "teardown");
  assert.equal(mapEventToStage("telemetry.synthetic_probe_burst"), "discovery");
  assert.equal(mapEventToStage("detection.synthetic_trip"), "detected");
  assert.equal(mapEventToStage("victim.agent_sensor"), "execution");
  assert.equal(mapEventToStage("some.future.event"), "recon");
});

test("stagesHit / activeStage reflect rail order and are null/empty with no events", () => {
  const entries = TL.entries.map((e) => ({ at: e.at, event: e.event, detail: e.detail }));
  const hit = stagesHit(entries);
  assert.ok(hit.has("arming") && hit.has("discovery") && hit.has("detected") && hit.has("teardown"));
  assert.equal(activeStage(entries), "teardown"); // latest in rail order
  assert.equal(activeStage([]), null);
  assert.equal(stagesHit([]).size, 0);
});

test("radar nodes come ONLY from attested targets; ring/angle are layout, never a measurement", () => {
  const targets = [
    { kind: "host", value: "10.77.0.11" },
    { kind: "host", value: "10.77.0.12" },
  ];
  const model = buildRadarModel(targets, []);
  assert.equal(model.nodes.length, 2);
  assert.deepEqual(model.nodes.map((n) => n.value), ["10.77.0.11", "10.77.0.12"]);
  assert.equal(model.nodes[0].ring, 1); // ≤3 targets sit on the inner ring
  assert.equal(model.nodes[0].angleDeg, 0);
  assert.equal(model.nodes[1].angleDeg, 180); // evenly spread
});

test("a half-known pair draws no arc and is recorded as ignored; a self-pair draws nothing", () => {
  const targets = [{ kind: "host", value: "10.77.0.11" }];
  const model = buildRadarModel(targets, [
    { at: "t1", event: "telemetry.x", detail: { from: "10.77.0.11", to: "203.0.113.9" } }, // `to` unknown
    { at: "t2", event: "telemetry.y", detail: { from: "10.77.0.11", to: "10.77.0.11" } }, // self-pair
  ]);
  assert.equal(model.arcs.length, 0);
  assert.ok(model.ignoredAddressRefs.map((r) => r.value).includes("203.0.113.9"), "unknown endpoint recorded as ignored");
});

test("a fully attested two-host pair draws exactly one arc carrying the real event name", () => {
  const targets = [
    { kind: "host", value: "10.77.0.11" },
    { kind: "host", value: "10.77.0.12" },
  ];
  const model = buildRadarModel(targets, [
    { at: "t1", event: "telemetry.probe", detail: { from: "10.77.0.11", to: "10.77.0.12" } },
  ]);
  assert.equal(model.arcs.length, 1);
  assert.equal(model.arcs[0].event, "telemetry.probe");
  assert.equal(model.ignoredAddressRefs.length, 0);
});

test("a detection pulses only at attested nodes; an unknown address never creates a node", () => {
  const targets = [{ kind: "host", value: "10.77.0.11" }];
  const model = buildRadarModel(targets, [
    { at: "t1", event: "detection.trip", detail: { to: "8.8.8.8" } }, // non-attested target
  ]);
  assert.equal(model.nodes.length, 1, "no node invented for 8.8.8.8");
  assert.equal(model.pulses.length, 1);
  assert.equal(model.pulses[0].node, model.nodes[0].id);
});

test("targetsFromTimeline derives the attested set from the episode's own {from,to}, deduped and order-stable", () => {
  const out = targetsFromTimeline(TL.entries as never);
  assert.deepEqual(out.map((t) => t.value), ["10.77.0.11", "10.77.0.12"]);
});

// ===========================================================================
// B. The SSE stream route (owner scope, honest replay, server-side signature)
// ===========================================================================

test("owner sees the full frame sequence: open(live:false) → events → evidence → done(signature recomputed true)", async () => {
  const res = (await callStream("range-1")) as unknown as FakeNextResponse;
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  const frames = await readFrames(res);
  const open = frames.find((f) => f.type === "open")!;
  assert.equal(open.live, false, "synchronous engine → honest REPLAY, labelled live:false");
  assert.equal(open.state, "torn_down");
  assert.equal(open.mode, "dry-run");
  assert.equal(open.scenarioSlug, "smoke");
  assert.equal((open.targets as unknown[]).length, 2);
  assert.equal(frames.filter((f) => f.type === "event").length, TL.entries.length, "one event frame per real timeline entry");
  assert.equal(frames.filter((f) => f.type === "evidence").length, 1);
  const done = frames.find((f) => f.type === "done")!;
  assert.equal(done.signatureValid, true);
  assert.deepEqual(done.techniques, ["T1046"]);
  assert.equal(done.signedHash, "deadbeef");
  assert.ok(done.teardownVerifiedAt);
  assert.deepEqual(state.verifyCalls, ["ep-1"], "validity recomputed from the STORED episode row");
});

test("a tampered stored episode flips signatureValid false — server recompute, client can't inject", async () => {
  state.verifyResult = false;
  const res = (await callStream("range-1")) as unknown as FakeNextResponse;
  const frames = await readFrames(res);
  assert.equal(frames.find((f) => f.type === "done")!.signatureValid, false);
  assert.deepEqual(state.verifyCalls, ["ep-1"]);
});

test("a foreign range id is a 404 (never an oracle); the verifier is never called", async () => {
  state.currentUser = { id: OTHER };
  const res = (await callStream("range-1")) as unknown as FakeNextResponse;
  assert.equal(res.status, 404);
  assert.deepEqual((res.json as Row).error, "Not found");
  assert.equal(res.body, null);
  assert.equal(state.verifyCalls.length, 0);
});

test("no session → 401; module-tools denied → the gate response is returned verbatim before any range read", async () => {
  state.currentUser = null;
  const anon = (await callStream("range-1")) as unknown as FakeNextResponse;
  assert.equal(anon.status, 401);

  state.currentUser = { id: USER };
  const sentinel = { denied: true };
  state.moduleDenied = sentinel;
  const denied = (await callStream("range-1")) as unknown;
  assert.equal(denied, sentinel);
});

test("a range with no episode reports signatureValid null and no event frames", async () => {
  state.episodes = [];
  const res = (await callStream("range-1")) as unknown as FakeNextResponse;
  const frames = await readFrames(res);
  const open = frames.find((f) => f.type === "open")!;
  assert.equal((open.targets as unknown[]).length, 0);
  assert.equal(frames.filter((f) => f.type === "event").length, 0);
  assert.equal(frames.find((f) => f.type === "done")!.signatureValid, null);
  assert.equal(state.verifyCalls.length, 0, "verifier not called when there is no episode");
});

// ===========================================================================
// C. Copy guards — the section keeps its honesty promise
// ===========================================================================

test("the SIMULATION · YOUR EQUIPMENT watermark is present in the Operation Console", () => {
  const src = readFileSync(fileURLToPath(new URL("../components/cyberlab-ops-console.tsx", import.meta.url)), "utf8");
  assert.ok(src.includes("SIMULATION · YOUR EQUIPMENT"), "watermark copy must ship");
});

test("/cyberlab is a session-gated top-level route with its own .lab-ops theme; the old in-dashboard console is gone", () => {
  const page = readFileSync(fileURLToPath(new URL("../app/cyberlab/page.tsx", import.meta.url)), "utf8");
  assert.ok(page.includes("getSession"), "the top-level route self-gates on a valid session");
  assert.ok(page.includes("CyberLabOpsConsole"), "it renders the Operation Console");
  const layout = readFileSync(fileURLToPath(new URL("../app/cyberlab/layout.tsx", import.meta.url)), "utf8");
  assert.ok(layout.includes("lab-ops"), "the section ships its own theme");
  assert.equal(existsSync(fileURLToPath(new URL("../components/cyberlab-console.tsx", import.meta.url))), false, "the superseded in-dashboard console is removed");
});

test("the dashboard keeps only a launcher card to /cyberlab (no console rendered inline)", () => {
  const panel = readFileSync(fileURLToPath(new URL("../components/cyberlab-panel.tsx", import.meta.url)), "utf8");
  assert.ok(panel.includes('href="/cyberlab"'), "the panel links out to the new section");
  assert.ok(!panel.includes("CyberLabConsole"), "the panel no longer renders the old console");
});

// TASK_156B V2 (Slice 1) — the lab now follows the app-wide light/dark toggle
// (no longer hard-forced dark), the header carries the house ThemeToggle, and
// an honest "How Cyber Lab works" guide ships with the console. These guards
// keep that promise and prevent the always-dark regression from returning.
test("the lab theme follows the app-wide light/dark toggle (light default + .dark variant, no forced dark)", () => {
  const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
  assert.ok(/\.lab-ops\s*\{/.test(css), "the light .lab-ops palette block exists");
  assert.ok(/\.dark\s+\.lab-ops\s*\{/.test(css), "the dark .lab-ops variant is keyed off the .dark class");
  const layout = readFileSync(fileURLToPath(new URL("../app/cyberlab/layout.tsx", import.meta.url)), "utf8");
  assert.ok(layout.includes("lab-ops"), "the section still ships its own scoped theme");
});

test("the Operation Console header carries the house ThemeToggle and a how-to guide", () => {
  const src = readFileSync(fileURLToPath(new URL("../components/cyberlab-ops-console.tsx", import.meta.url)), "utf8");
  assert.ok(src.includes('from "@/components/theme-toggle"'), "the house toggle is imported, not reinvented");
  assert.ok(src.includes("<ThemeToggle />"), "the toggle is mounted in the header");
  assert.ok(src.includes("How Cyber Lab works"), "the how-to guide ships");
  assert.ok(src.includes("dry-run"), "the guide is honest about today's dry-run reality");
  assert.ok(src.includes("scan"), "the guide explains the scan-first journey");
});

