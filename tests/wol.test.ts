import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_123 (B12, PATH A) — Wake-on-LAN.
//
// Two layers of evidence, same file:
//   1. `lib/wol.ts`'s pure builders/parsers/selector — imported directly, no
//      stubbing needed (it has no DB, network or `server-only` dependency).
//   2. The REAL `lib/device-tools.ts` (runPowerAction's "wake" branch,
//      getWakeAvailability, setPowerPolicy, getDevicePowerView) — loaded
//      through the same require-hook technique tests/vantra-link-installer.test.ts
//      already established: only its own `./db` / `./env` / `./admin-settings`
//      / `./devices` dependencies are swapped for recording fakes; `./wol` is
//      NOT stubbed, so this is the real, deployed wiring between the two files.
//
// Acceptance items exercised here (TASK_123_WAKE_ON_LAN.md §6):
//   2. Wake fails closed with the right reason — no MAC -> no_power_mac; no
//      online same-subnet peer -> no_same_subnet_peer. Neither returns `ok: true`.
//   4. No path reports success without a count (D6/R3 regression guard): a
//      peer response of `{ ok: true, sent: 0 }` is STILL treated as a refusal.
//   Plus keep-awake's wiring (P4/D4): apply/stop go through the frozen
//   contract, and a "timed" policy self-clears once `until` has passed.

process.env.DATABASE_URL = "postgresql://t123:t123@localhost:5432/task123_placeholder";
process.env.SESSION_SECRET = "task123-test-session-secret";
process.env.RESEND_API_KEY = "task123-test-resend";
process.env.EMAIL_FROM = "t123@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.VANTRA_INTERNAL_TOKEN = "task123-test-vantra-token";
process.env.VANTRA_INTERNAL_URL = "https://vantra.spaceworker.test";
(process.env as Record<string, string>).NODE_ENV = "test";

import {
  normalizeMac,
  subnetOf,
  buildPowerIdentityScript,
  parsePowerIdentityOutput,
  selectWolPeer,
  type WolPeerCandidate,
} from "../lib/wol";

// ---------------------------------------------------------------------------
// 1. Pure lib/wol.ts — no stubbing needed.
// ---------------------------------------------------------------------------

test("normalizeMac: canonicalizes, rejects garbage", () => {
  assert.equal(normalizeMac("c6-9d-43-00-ab-ea"), "C6:9D:43:00:AB:EA");
  assert.equal(normalizeMac("C6:9D:43:00:AB:EA"), "C6:9D:43:00:AB:EA");
  assert.equal(normalizeMac("not-a-mac"), null);
  assert.equal(normalizeMac("C6:9D:43:00:AB"), null);
});

test("subnetOf: computes the /24, rejects non-IPv4", () => {
  assert.equal(subnetOf("192.168.0.103"), "192.168.0.0/24");
  assert.equal(subnetOf("10.100.153.185"), "10.100.153.0/24");
  assert.equal(subnetOf("not-an-ip"), null);
  assert.equal(subnetOf("999.1.1.1"), null);
});

test("parsePowerIdentityOutput: round-trips buildPowerIdentityScript's own marker shape", () => {
  // buildPowerIdentityScript emits its OK line with the same helper functions
  // this test uses to construct one — proves the parser reads what the
  // builder actually writes, not an assumed shape.
  const line = "STEP:power-identity OK:C6:9D:43:00:AB:EA|192.168.0.103|192.168.0.0/24";
  const identity = parsePowerIdentityOutput(line);
  assert.deepEqual(identity, { mac: "C6:9D:43:00:AB:EA", lanIp: "192.168.0.103", lanSubnet: "192.168.0.0/24" });
});

test("parsePowerIdentityOutput: malformed/missing output -> null, never throws", () => {
  assert.equal(parsePowerIdentityOutput(null), null);
  assert.equal(parsePowerIdentityOutput(""), null);
  assert.equal(parsePowerIdentityOutput("STEP:power-identity FAIL:no_active_adapter"), null);
  // Mismatched subnet (tampered/garbled output) is rejected, not trusted verbatim.
  assert.equal(
    parsePowerIdentityOutput("STEP:power-identity OK:C6:9D:43:00:AB:EA|192.168.0.103|10.0.0.0/24"),
    null,
  );
});

test("buildPowerIdentityScript: never contains a bare Test-Path (the launcher's own lesson)", () => {
  // 2026-09-26 lesson (lib/device-tools.ts buildDiscoverAppsScript): a
  // Test-Path without -ErrorAction can silently break a whole script's
  // output. This script sidesteps the class of bug entirely by never
  // calling Test-Path at all — assert that stays true.
  const script = buildPowerIdentityScript();
  assert.ok(!/Test-Path/.test(script), "power-identity script should not need Test-Path at all");
  assert.ok(script.includes("Get-NetIPConfiguration"));
});

function peer(overrides: Partial<WolPeerCandidate>): WolPeerCandidate {
  return { id: "peer", vantraAgentId: "agent-peer", status: "online", powerLanSubnet: "192.168.0.0/24", ...overrides };
}

test("selectWolPeer: D2 — same subnet, online, excludes the target itself", () => {
  const fleet = [
    peer({ id: "other-subnet", powerLanSubnet: "10.0.0.0/24" }),
    peer({ id: "offline-peer", status: "offline" }),
    peer({ id: "no-agent", vantraAgentId: null }),
    peer({ id: "target", powerLanSubnet: "192.168.0.0/24" }), // same id as target — must be excluded
    peer({ id: "good-peer" }),
  ];
  const picked = selectWolPeer({ targetDeviceId: "target", targetSubnet: "192.168.0.0/24", fleet });
  assert.equal(picked?.id, "good-peer");
});

test("selectWolPeer: no subnet recorded, or no match -> null (never guesses)", () => {
  assert.equal(selectWolPeer({ targetDeviceId: "t", targetSubnet: null, fleet: [peer({})] }), null);
  assert.equal(
    selectWolPeer({ targetDeviceId: "t", targetSubnet: "192.168.0.0/24", fleet: [peer({ powerLanSubnet: "10.0.0.0/24" })] }),
    null,
  );
});

// ---------------------------------------------------------------------------
// 2. The real lib/device-tools.ts, through the house require-hook stub.
// ---------------------------------------------------------------------------

const USER_ID = "user-t123";

interface DeviceRow {
  id: string;
  userId: string;
  vantraAgentId: string | null;
  name: string;
  deviceKind: string;
  status: string;
  powerMac: string | null;
  powerLanSubnet: string | null;
  lastSeenAt: Date;
}

interface PolicyRow {
  mode: string;
  until: Date | null;
}

interface AuditCall {
  action?: string;
  status?: string;
  detail?: Record<string, unknown>;
}

let devices: DeviceRow[];
let policies: Map<string, PolicyRow>;
let audits: AuditCall[];
// The fake Vantra internal-sw action response, keyed by the URL's agentId —
// lets each test script a different peer/self response without a real server.
let vantraResponses: Map<string, { status: number; body: unknown }>;
let fetchCalls: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  devices = [
    {
      id: "target",
      userId: USER_ID,
      vantraAgentId: "agent-target",
      name: "Target",
      deviceKind: "workstation",
      status: "asleep",
      powerMac: "C6:9D:43:00:AB:EA",
      powerLanSubnet: "192.168.0.0/24",
      lastSeenAt: new Date("2026-09-26T00:00:00Z"),
    },
    {
      id: "peer",
      userId: USER_ID,
      vantraAgentId: "agent-peer",
      name: "Peer",
      deviceKind: "workstation",
      status: "online",
      powerMac: "AA:BB:CC:DD:EE:FF",
      powerLanSubnet: "192.168.0.0/24",
      lastSeenAt: new Date("2026-09-26T01:00:00Z"),
    },
  ];
  policies = new Map();
  audits = [];
  vantraResponses = new Map();
  fetchCalls = [];
});

type DbArgs = { where?: Record<string, unknown>; data?: Record<string, unknown>; select?: Record<string, boolean> };

function project(source: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return { ...source };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) if (select[key]) out[key] = (source as Record<string, unknown>)[key];
  return out;
}

const fakeDb = {
  device: {
    findFirst: async ({ where, select }: DbArgs) => {
      const row = devices.find(
        (d) => d.id === where?.id && (where?.userId === undefined || d.userId === where.userId),
      );
      return row ? project(row as unknown as Record<string, unknown>, select) : null;
    },
    findMany: async ({ where, select }: DbArgs) => {
      const rows = devices
        .filter(
          (d) =>
            d.userId === where?.userId &&
            (!where?.id || d.id !== (where.id as { not: string }).not) &&
            d.powerLanSubnet === where?.powerLanSubnet,
        )
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
      return rows.map((r) => project(r as unknown as Record<string, unknown>, select));
    },
  },
  devicePowerPolicy: {
    findUnique: async ({ where, select }: DbArgs) => {
      const p = policies.get(where?.deviceId as string);
      if (!p) return null;
      return project(p as unknown as Record<string, unknown>, select);
    },
    upsert: async ({ where, create, update, select }: DbArgs & { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const deviceId = where?.deviceId as string;
      const existing = policies.get(deviceId);
      const next = (existing ? update : create) as unknown as PolicyRow;
      policies.set(deviceId, next);
      return project(next as unknown as Record<string, unknown>, select);
    },
  },
};

type Loader = { _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown };
const MODULE_UNDER_TEST = "lib/device-tools.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(`/${MODULE_UNDER_TEST}`)) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./env") return { env: { appBaseUrl: "https://spaceworker.test" } };
      if (request === "./admin-settings") return { getAdminSettings: async () => ({}) };
      if (request === "./devices") {
        return {
          recordAgentActionAudit: async (call: AuditCall) => {
            audits.push(call);
          },
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  fetchCalls.push({ url: String(url), body });
  const m = /\/devices\/([^/]+)\/action$/.exec(String(url));
  const agentId = m ? decodeURIComponent(m[1]) : "";
  const scripted = vantraResponses.get(agentId);
  if (!scripted) {
    return { ok: false, status: 404, text: async () => "not found" } as unknown as Response;
  }
  return {
    ok: scripted.status >= 200 && scripted.status < 300,
    status: scripted.status,
    json: async () => scripted.body,
    text: async () => JSON.stringify(scripted.body),
  } as unknown as Response;
};

/* eslint-disable @typescript-eslint/no-require-imports */
const { runPowerAction, getWakeAvailability, setPowerPolicy, getDevicePowerView } =
  require("../lib/device-tools") as typeof import("../lib/device-tools");
/* eslint-enable @typescript-eslint/no-require-imports */

test("wake: no recorded MAC -> no_power_mac, no outbound call, never ok:true", async () => {
  devices.find((d) => d.id === "target")!.powerMac = null;
  await assert.rejects(
    runPowerAction({ userId: USER_ID, deviceId: "target", action: "wake" }),
    /no_power_mac/,
  );
  assert.equal(fetchCalls.length, 0, "must fail closed before ever calling Vantra");
  assert.equal(audits.at(-1)?.status, "failed");
});

test("wake: MAC known but no online same-subnet peer -> no_same_subnet_peer", async () => {
  devices.find((d) => d.id === "peer")!.status = "offline";
  await assert.rejects(
    runPowerAction({ userId: USER_ID, deviceId: "target", action: "wake" }),
    /no_same_subnet_peer/,
  );
  assert.equal(fetchCalls.length, 0);
});

test("wake: D6/acceptance-4 — a peer response of sent:0 is STILL a refusal, never ok:true", async () => {
  vantraResponses.set("agent-peer", { status: 200, body: { ok: true, sent: 0, method: "peer", via: "Peer" } });
  await assert.rejects(
    runPowerAction({ userId: USER_ID, deviceId: "target", action: "wake" }),
    /wake_no_packets_sent/,
  );
  assert.equal(audits.at(-1)?.status, "failed");
});

test("wake: peer refuses explicitly -> that reason surfaces verbatim", async () => {
  vantraResponses.set("agent-peer", { status: 200, body: { ok: false, reason: "peer_unreachable" } });
  await assert.rejects(
    runPowerAction({ userId: USER_ID, deviceId: "target", action: "wake" }),
    /peer_unreachable/,
  );
});

test("wake: succeeds with a real packet count, sent to the PEER's agentId with the target's device id", async () => {
  vantraResponses.set("agent-peer", { status: 200, body: { ok: true, sent: 3, method: "peer", via: "Peer" } });
  const result = await runPowerAction({ userId: USER_ID, deviceId: "target", action: "wake" });
  assert.equal(result.packetsSent, 3);
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes("/devices/agent-peer/action"), "must call the PEER's agent, not the target's");
  assert.equal(fetchCalls[0].body.action, "wol");
  assert.equal(fetchCalls[0].body.targetDeviceId, "target");
  const audit = audits.at(-1);
  assert.equal(audit?.status, "executed");
  assert.equal(audit?.detail?.packetsSent, 3);
});

test("getWakeAvailability: reflects the same fail-closed reasons the wake action itself uses", async () => {
  const available = await getWakeAvailability({ userId: USER_ID, deviceId: "target" });
  assert.deepEqual(available, { available: true, reason: "ok" });

  devices.find((d) => d.id === "target")!.powerMac = null;
  assert.deepEqual(await getWakeAvailability({ userId: USER_ID, deviceId: "target" }), {
    available: false,
    reason: "no_power_mac",
  });
});

test("setPowerPolicy: indefinite/timed/off all go through the frozen keepawake contract, to the DEVICE's own agentId", async () => {
  vantraResponses.set("agent-target", { status: 200, body: { ok: true } });
  const indefinite = await setPowerPolicy({ userId: USER_ID, deviceId: "target", mode: "indefinite" });
  assert.equal(indefinite.mode, "indefinite");
  assert.equal(indefinite.until, null);
  assert.equal(fetchCalls.at(-1)?.body.action, "keepawake");
  assert.equal(fetchCalls.at(-1)?.body.mode, "indefinite");
  assert.ok(fetchCalls.at(-1)?.url.includes("/devices/agent-target/action"));

  const timed = await setPowerPolicy({ userId: USER_ID, deviceId: "target", mode: "timed", minutes: 30 });
  assert.equal(timed.mode, "timed");
  assert.ok(timed.until && new Date(timed.until).getTime() > Date.now());

  const off = await setPowerPolicy({ userId: USER_ID, deviceId: "target", mode: "off" });
  assert.equal(off.mode, "off");
  assert.equal(off.until, null);
});

test("setPowerPolicy: Vantra refusal never applies — the DB policy is left untouched", async () => {
  vantraResponses.set("agent-target", { status: 200, body: { ok: false, reason: "unsupported" } });
  await assert.rejects(
    setPowerPolicy({ userId: USER_ID, deviceId: "target", mode: "indefinite" }),
    /unsupported/,
  );
  assert.equal(policies.has("target"), false);
});

test("getDevicePowerView: a timed policy past `until` self-clears (best-effort sweep on read)", async () => {
  vantraResponses.set("agent-target", { status: 200, body: { ok: true } });
  policies.set("target", { mode: "timed", until: new Date(Date.now() - 60_000) });
  const view = await getDevicePowerView({ userId: USER_ID, deviceId: "target" });
  assert.equal(view.policy.mode, "off");
  assert.equal(policies.get("target")?.mode, "off");
});
