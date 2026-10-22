import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_231 — the deletion pair, end to end: the admin's "Move to Deleted" +
// "Delete permanently", and the customer console's now-silent delete.
//
// Three layers, each proving what the layer above it cannot:
//   1. GUARD  — the REAL `ensureSwAgentRemoved` (lib/vantra-link) against a
//               stubbed fetch: a successful Vantra uninstall answers `true`
//               WITHOUT ever listing the orgs; a failed one proves absence
//               from the exact lists `syncDevices` reads — still listed ⇒
//               `agent_still_active`, a list we cannot fetch ⇒
//               `agent_unverified`, no/revoked link ⇒ false (sync can never
//               run, so nothing can resurrect the row).
//   2. ROUTES — purge: 403 without the admin session, the error→status map
//               (404/409/409/503), audit ONLY on success. remove: 403, deep
//               404 before any mutation, `localOnly` passthrough, and
//               `agent_offline` → 503 carrying the machine-readable `code`
//               the UI's honest "Move anyway" retry keys on.
//   3. LIB+UI — `purgeAdminDevice` against a fake db: every guard fires
//               BEFORE anything destructive, frames before rows, and all 12
//               RESTRICT children plus device.delete run inside ONE
//               transaction with device.delete last; then the static locks
//               on both UIs (customer offline dialog gone + silent fallback
//               kept; both admin buttons wired to their routes).
// ---------------------------------------------------------------------------

// Set BEFORE lib/vantra-link is required: lib/env.ts evaluates its required()
// checks at import time, and swHeaders() fails closed without the Vantra
// token. Placeholders are correct — nothing dials out for real (the fetch
// below is stubbed).
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://t231:t231@localhost:5432/task231_placeholder";
process.env.SESSION_SECRET = "t231-test-session-secret";
process.env.RESEND_API_KEY = "t231-test-resend";
process.env.EMAIL_FROM = "t231@spaceworker.test";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.VANTRA_INTERNAL_TOKEN = "t231-test-vantra-token";
process.env.VANTRA_INTERNAL_URL = "https://vantra.spaceworker.test";
// NODE_ENV is declared read-only in @types/node; a test run genuinely is one.
(process.env as Record<string, string>).NODE_ENV = "test";

const PURGE_ROUTE = "/app/api/admin/devices/[deviceId]/purge/route.ts";
const REMOVE_ROUTE = "/app/api/admin/devices/[deviceId]/remove/route.ts";
const ADMIN_DEVICES_LIB = "/lib/admin-devices.ts";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Minimal NextResponse stand-in — every return here is `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

// ---------------------------------------------------------------------------
// Fake db for lib/admin-devices (the purge unit). The deleteMany/delete
// delegates return DESCRIPTORS instead of running — Prisma's batch
// $transaction receives its steps lazily too — so the recorded order below
// is the order the transaction executes them. device.delete is applied to the
// store only when the transaction runs it, which also proves the guard paths
// above it never reach the store at all.
// ---------------------------------------------------------------------------
interface FakeDevice {
  id: string;
  userId: string;
  name: string;
  removedAt: Date | null;
  vantraAgentId: string | null;
}

interface TxStep {
  op: string;
  args: Record<string, unknown>;
}

const purgeStore: { devices: FakeDevice[] } = { devices: [] };
/** One shared order stream: ensure → frames → the transaction's own steps. */
let ops: string[] = [];
let txSteps: TxStep[] = [];
const frameCalls: string[] = [];

const childStep =
  (op: string) =>
  (args: Record<string, unknown>): TxStep => ({ op, args });

const purgeDb = {
  device: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const d = purgeStore.devices.find((x) => x.id === where.id);
      if (!d) return null;
      return {
        id: d.id,
        name: d.name,
        userId: d.userId,
        removedAt: d.removedAt,
        vantraAgentId: d.vantraAgentId,
        user: { id: d.userId, email: "owner@example.com", tier: 1 },
      };
    },
    delete: childStep("device.delete"),
  },
  deviceRelationship: { deleteMany: childStep("deviceRelationship.deleteMany") },
  cloneJob: { deleteMany: childStep("cloneJob.deleteMany") },
  hostedBrowserSession: { deleteMany: childStep("hostedBrowserSession.deleteMany") },
  relayHealth: { deleteMany: childStep("relayHealth.deleteMany") },
  devicePowerPolicy: { deleteMany: childStep("devicePowerPolicy.deleteMany") },
  deviceQueuedCommand: { deleteMany: childStep("deviceQueuedCommand.deleteMany") },
  devicePinRequest: { deleteMany: childStep("devicePinRequest.deleteMany") },
  deviceCapability: { deleteMany: childStep("deviceCapability.deleteMany") },
  deviceHeartbeat: { deleteMany: childStep("deviceHeartbeat.deleteMany") },
  deviceJob: { deleteMany: childStep("deviceJob.deleteMany") },
  deviceAction: { deleteMany: childStep("deviceAction.deleteMany") },
  deviceAudit: { deleteMany: childStep("deviceAudit.deleteMany") },
  $transaction: async (steps: TxStep[]) => {
    ops.push("tx:start");
    for (const s of steps) {
      ops.push(s.op);
      txSteps.push(s);
      if (s.op === "device.delete") {
        const where = (s.args.where ?? {}) as { id?: string };
        const i = purgeStore.devices.findIndex((x) => x.id === where.id);
        if (i >= 0) purgeStore.devices.splice(i, 1);
      }
    }
    ops.push("tx:end");
    return [];
  },
};

// ---------------------------------------------------------------------------
// The REAL ensureSwAgentRemoved's world: just enough fake db (the link row
// it consults) plus a scenario-driven fetch stub.
// ---------------------------------------------------------------------------
let linkRow: {
  userId: string;
  orgId: string;
  status: string;
  privateOrgId: string | null;
} | null;
/** Status for the `action: delete` call: <400 = removed, >=400 = refused. */
let actionStatus: number;
/** Per-org answer for /api/internal/sw/devices?orgId=… (missing key ⇒ 503). */
let lists: Record<string, { ok: boolean; payload: unknown }>;
const fetches: Array<{ url: string; method: string | undefined }> = [];

const vantraLinkFakeDb = {
  vantraLink: {
    findUnique: async ({ where }: { where: { userId?: string } }) =>
      linkRow && where.userId === linkRow.userId ? { ...linkRow } : null,
  },
};

// ---------------------------------------------------------------------------
// Fakes for the admin-devices dep graph (recorders for the steps under test).
// ---------------------------------------------------------------------------
const ensureCalls: Array<{ userId: string; agentId: string }> = [];
let ensureBehavior:
  | { kind: "return"; value: boolean }
  | { kind: "throw"; code: string } = { kind: "return", value: true };

const ADMIN_VANTRA_DEP = {
  fetchUserIdle: async () => ({}),
  ensureSwAgentRemoved: async (opts: { userId: string; agentId: string }) => {
    ensureCalls.push(opts);
    ops.push("ensure");
    if (ensureBehavior.kind === "throw") throw new Error(ensureBehavior.code);
    return ensureBehavior.value;
  },
};

const SHOTS_DEP = {
  deleteDeviceFrameTree: async (id: string) => {
    frameCalls.push(id);
    ops.push(`frames:${id}`);
  },
};

// ---------------------------------------------------------------------------
// The require hook (house pattern, HOW_WE_MOVE_FAST §4).
// ---------------------------------------------------------------------------
interface Overrides {
  [request: string]: unknown;
}

let overrides: Overrides = {};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (parent?.filename && request in overrides) return overrides[request];
  if (request === "server-only") return {};
  if (request === "next/server") return { NextResponse: fakeNextResponse };
  const from = parent?.filename ?? "";
  // lib/admin-devices.ts — the purge's dep graph (the six relative imports).
  if (from.endsWith("/lib/admin-devices.ts")) {
    if (request === "./db") return { db: purgeDb };
    if (request === "./devices")
      return { deviceStatus: (r: { status?: string }) => r.status ?? "offline" };
    if (request === "./device-tools") return { adminRunDeviceCommand: async () => ({}) };
    if (request === "./vantra-link") return ADMIN_VANTRA_DEP;
    if (request === "./device-screenshots") return SHOTS_DEP;
  }
  // lib/vantra-link.ts — the REAL module under test (the guard layer): five
  // intercepted deps, exactly as tests/vantra-link-installer.test.ts proves
  // loadable; everything else (env, agent-visibility, …) loads real.
  if (from.endsWith("/lib/vantra-link.ts")) {
    if (request === "./db") return { db: vantraLinkFakeDb };
    if (request === "./entitlements") return { hasEntitlement: async () => ({ allowed: false }) };
    if (request === "./devices") return { recordAgentActionAudit: async () => {} };
    if (request === "./admin-settings") return { getAdminSettings: async () => ({}) };
    if (request === "./device-tools")
      return {
        executePinRequest: async () => ({ output: null }),
        startMaintenanceOverlayAction: async () => ({}),
        stopMaintenanceOverlayAction: async () => ({}),
      };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Stubbed fetch: the action call answers from `actionStatus`, the org lists
// from `lists` (keyed by orgId; absent key ⇒ 503, which is "cannot verify").
// ---------------------------------------------------------------------------
(globalThis as unknown as { fetch: unknown }).fetch = async (
  url: unknown,
  init?: RequestInit,
) => {
  const urlStr = String(url);
  fetches.push({ url: urlStr, method: init?.method });
  const mk = (ok: boolean, status: number, payload: unknown) =>
    ({ ok, status, json: async () => payload, text: async () => "" }) as unknown as Response;
  if (urlStr.includes("/action")) {
    return actionStatus < 400
      ? mk(true, 200, { ok: true, deleted: true })
      : mk(false, actionStatus, { error: "unreachable" });
  }
  const orgId = new URL(urlStr).searchParams.get("orgId") ?? "";
  const entry = lists[orgId];
  if (!entry) return mk(false, 503, { error: "unreachable" });
  return entry.ok ? mk(true, 200, entry.payload) : mk(false, 500, {});
};

/* eslint-disable @typescript-eslint/no-require-imports */
const realVantraLink = require(path.join(ROOT, "lib/vantra-link.ts")) as {
  ensureSwAgentRemoved: (opts: { userId: string; agentId: string }) => Promise<boolean>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

type Result = { status: number; body: unknown };

/** Require a module fresh with `deps` substituted for its imports. */
function loadFresh(file: string, deps: Overrides = {}) {
  const abs = require.resolve(`..${file}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as Record<string, unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

function purgeLib() {
  return loadFresh(ADMIN_DEVICES_LIB) as {
    purgeAdminDevice: (o: { deviceId: string }) => Promise<{
      id: string;
      name: string;
      agentRemoved: boolean;
      owner: { id: string; email: string; tier: number };
    }>;
  };
}

// The admin session each scenario answers with (null ⇒ the 403 path).
let adminValue: { sub: string } | null;
const ADMIN_DEP = {
  getAdminSession: async () => adminValue,
  requireAdminSession: async () => adminValue !== null,
};

const purgeCalls: Array<{ deviceId: string }> = [];
let purgeThrows: string | null = null;
const PURGE_DEP = {
  purgeAdminDevice: async (opts: { deviceId: string }) => {
    purgeCalls.push(opts);
    if (purgeThrows) throw new Error(purgeThrows);
    return {
      id: opts.deviceId,
      name: "Box",
      agentRemoved: true,
      owner: { id: "u_owner", email: "o@example.com", tier: 1 },
    };
  },
};

const assertCalls: string[] = [];
let assertThrows: string | null = null;
const ACCESS_DEP = {
  assertAdminDeviceAccess: async (deviceId: string) => {
    assertCalls.push(deviceId);
    if (assertThrows) throw new Error(assertThrows);
    return { id: deviceId, name: "Box", owner: { id: "u_owner", email: "o@example.com" } };
  },
};

const removeCalls: Array<Record<string, unknown>> = [];
let removeThrows: string | null = null;
const REMOVE_DEP = {
  removeDevice: async (opts: Record<string, unknown>) => {
    removeCalls.push(opts);
    if (removeThrows) throw new Error(removeThrows);
    return { agentRemoved: opts.localOnly !== true };
  },
};

const auditCalls: Array<Record<string, unknown>> = [];
const AUDIT_DEP = {
  recordAgentActionAudit: async (opts: Record<string, unknown>) => void auditCalls.push(opts),
};

const PARAMS = { params: Promise.resolve({ deviceId: "dev_1" }) };
const req = (body: unknown) => ({ json: async () => body }) as never;

function seedPurgeDevice(row: Partial<FakeDevice> = {}): void {
  purgeStore.devices.push({
    id: "dev_1",
    userId: "u_owner",
    name: "Box",
    removedAt: new Date(),
    vantraAgentId: "agent_1",
    ...row,
  });
}

beforeEach(() => {
  purgeStore.devices.length = 0;
  ops = [];
  txSteps = [];
  frameCalls.length = 0;
  ensureCalls.length = 0;
  ensureBehavior = { kind: "return", value: true };
  linkRow = { userId: "u_owner", orgId: "org_a", status: "active", privateOrgId: null };
  actionStatus = 200;
  lists = { org_a: { ok: true, payload: { ok: true, devices: [] } } };
  fetches.length = 0;
  adminValue = { sub: "admin" };
  purgeCalls.length = 0;
  purgeThrows = null;
  assertCalls.length = 0;
  assertThrows = null;
  removeCalls.length = 0;
  removeThrows = null;
  auditCalls.length = 0;
  overrides = {};
});

const AGENT = "agent_1";

// ---------------------------------------------------------------------------
// 1. GUARD — the real ensureSwAgentRemoved
// ---------------------------------------------------------------------------

test("guard: a successful Vantra uninstall returns true without ever listing the orgs", async () => {
  const removed = await realVantraLink.ensureSwAgentRemoved({
    userId: "u_owner",
    agentId: AGENT,
  });
  assert.equal(removed, true, "the action call did the removal");
  assert.equal(fetches.length, 1, "exactly the action call — no list round-trip");
  assert.ok(fetches[0].url.endsWith(`/devices/${AGENT}/action`));
  assert.equal(
    fetches.filter((f) => f.url.includes("orgId")).length,
    0,
    "nothing to verify when the uninstall succeeded",
  );
});

test("guard: action refused + agent still listed → agent_still_active (the purge abort signal)", async () => {
  actionStatus = 503;
  lists = { org_a: { ok: true, payload: { ok: true, devices: [{ vantraAgentId: AGENT }] } } };
  await assert.rejects(
    () => realVantraLink.ensureSwAgentRemoved({ userId: "u_owner", agentId: AGENT }),
    /agent_still_active/,
  );
});

test("guard: BOTH org lists are consulted — an agent hiding only in the private companion is found", async () => {
  actionStatus = 503;
  linkRow = { userId: "u_owner", orgId: "org_a", status: "active", privateOrgId: "org_priv" };
  lists = {
    org_a: { ok: true, payload: { ok: true, devices: [] } },
    org_priv: { ok: true, payload: { ok: true, devices: [{ vantraAgentId: AGENT }] } },
  };
  await assert.rejects(
    () => realVantraLink.ensureSwAgentRemoved({ userId: "u_owner", agentId: AGENT }),
    /agent_still_active/,
  );
  assert.equal(
    fetches.filter((f) => f.url.includes("orgId")).length,
    2,
    "public then private — the same merge syncDevices does",
  );
});

test("guard: action refused + the list unreachable → agent_unverified (never a blind yes)", async () => {
  actionStatus = 503;
  lists = { org_a: { ok: false, payload: {} } };
  await assert.rejects(
    () => realVantraLink.ensureSwAgentRemoved({ userId: "u_owner", agentId: AGENT }),
    /agent_unverified/,
  );
});

test("guard: action refused + NO link → false, with zero list calls (sync can't run at all)", async () => {
  actionStatus = 503;
  linkRow = null;
  const removed = await realVantraLink.ensureSwAgentRemoved({
    userId: "u_owner",
    agentId: AGENT,
  });
  assert.equal(removed, false);
  assert.equal(fetches.filter((f) => f.url.includes("orgId")).length, 0);
});

test("guard: a REVOKED link is treated like no link — false, no list calls", async () => {
  actionStatus = 503;
  linkRow = { userId: "u_owner", orgId: "org_a", status: "revoked", privateOrgId: null };
  const removed = await realVantraLink.ensureSwAgentRemoved({
    userId: "u_owner",
    agentId: AGENT,
  });
  assert.equal(removed, false);
  assert.equal(fetches.filter((f) => f.url.includes("orgId")).length, 0);
});

test("guard: action refused + lists clean → false (already gone, safe to purge)", async () => {
  actionStatus = 503;
  const removed = await realVantraLink.ensureSwAgentRemoved({
    userId: "u_owner",
    agentId: AGENT,
  });
  assert.equal(removed, false);
  assert.equal(fetches.filter((f) => f.url.includes("orgId")).length, 1);
});

// ---------------------------------------------------------------------------
// 2. ROUTES
// ---------------------------------------------------------------------------

test("purge DELETE → 403 without an admin session; nothing is purged or audited", async () => {
  adminValue = null;
  const route = loadFresh(PURGE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": PURGE_DEP,
    "@/lib/devices": AUDIT_DEP,
  });
  const res = await (route.DELETE as (r: unknown, c: unknown) => Promise<Result>)({}, PARAMS);
  assert.equal(res.status, 403);
  assert.equal(purgeCalls.length, 0, "the purge must never be reached");
  assert.equal(auditCalls.length, 0);
});

test("purge DELETE → 200 audits device_purged on the admin rail, with the agent outcome", async () => {
  const route = loadFresh(PURGE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": PURGE_DEP,
    "@/lib/devices": AUDIT_DEP,
  });
  const res = await (route.DELETE as (r: unknown, c: unknown) => Promise<Result>)({}, PARAMS);
  assert.equal(res.status, 200);
  assert.deepEqual(purgeCalls, [{ deviceId: "dev_1" }]);
  assert.equal(auditCalls.length, 1, "the house pattern audits every admin mutation");
  assert.equal(auditCalls[0].action, "device_purged");
  assert.equal(auditCalls[0].approvalChannel, "admin");
  assert.equal(auditCalls[0].initiatingChannel, "api");
  assert.equal(auditCalls[0].sourceDeviceId, "dev_1");
  assert.equal(auditCalls[0].userId, "u_owner", "the audit lands on the OWNER's rail");
  assert.deepEqual(auditCalls[0].detail, { name: "Box", agentRemoved: true });
});

test("purge DELETE: error → status map — 404 / 409 / 409 / 503, never audited", async () => {
  const cases: Array<[string, number]> = [
    ["device_not_found", 404],
    ["device_not_deleted", 409],
    ["agent_still_active", 409],
    ["agent_unverified", 503],
  ];
  for (const [code, status] of cases) {
    purgeThrows = code;
    const route = loadFresh(PURGE_ROUTE, {
      "@/lib/admin-auth": ADMIN_DEP,
      "@/lib/admin-devices": PURGE_DEP,
      "@/lib/devices": AUDIT_DEP,
    });
    const res = await (route.DELETE as (r: unknown, c: unknown) => Promise<Result>)({}, PARAMS);
    assert.equal(res.status, status, `${code} must map to ${status}`);
    assert.equal(auditCalls.length, 0, `${code} is a refusal — nothing to audit`);
    purgeThrows = null;
  }
});

test("remove POST → 403 without an admin session; nothing is asserted or removed", async () => {
  adminValue = null;
  const route = loadFresh(REMOVE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": ACCESS_DEP,
    "@/lib/vantra-link": REMOVE_DEP,
  });
  const res = await (route.POST as (r: unknown, c: unknown) => Promise<Result>)(
    req({}),
    PARAMS,
  );
  assert.equal(res.status, 403);
  assert.equal(assertCalls.length, 0);
  assert.equal(removeCalls.length, 0);
});

test("remove POST → deep-404s an unknown/soft-deleted row BEFORE the mutation", async () => {
  assertThrows = "device_not_found";
  const route = loadFresh(REMOVE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": ACCESS_DEP,
    "@/lib/vantra-link": REMOVE_DEP,
  });
  const res = await (route.POST as (r: unknown, c: unknown) => Promise<Result>)(
    req({}),
    PARAMS,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(assertCalls, ["dev_1"]);
  assert.equal(removeCalls.length, 0, "the guard is the door — no mutation behind it");
});

test("remove POST → runs removeDevice as the OWNER with approvalChannel: admin", async () => {
  const route = loadFresh(REMOVE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": ACCESS_DEP,
    "@/lib/vantra-link": REMOVE_DEP,
  });
  const res = await (route.POST as (r: unknown, c: unknown) => Promise<Result>)(
    req({}),
    PARAMS,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, agentRemoved: true });
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0], {
    userId: "u_owner",
    deviceId: "dev_1",
    localOnly: false,
    approvalChannel: "admin",
  });
});

test("remove POST → passes localOnly: true through for the admin's 'Move anyway'", async () => {
  const route = loadFresh(REMOVE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": ACCESS_DEP,
    "@/lib/vantra-link": REMOVE_DEP,
  });
  const res = await (route.POST as (r: unknown, c: unknown) => Promise<Result>)(
    req({ localOnly: true }),
    PARAMS,
  );
  assert.equal(res.status, 200);
  assert.equal(removeCalls[0].localOnly, true);
  assert.equal(removeCalls[0].approvalChannel, "admin", "still stamped as the admin's act");
});

test("remove POST: agent_offline → 503 with code: 'agent_offline'; other failures → 502", async () => {
  removeThrows = "agent_offline";
  const route = loadFresh(REMOVE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": ACCESS_DEP,
    "@/lib/vantra-link": REMOVE_DEP,
  });
  const offline = await (route.POST as (r: unknown, c: unknown) => Promise<Result>)(
    req({}),
    PARAMS,
  );
  assert.equal(offline.status, 503);
  assert.equal(
    (offline.body as { code?: string }).code,
    "agent_offline",
    "the UI keys its honest second confirm on this code",
  );

  removeThrows = "vantra_502: trmm exploded";
  const failed = await (route.POST as (r: unknown, c: unknown) => Promise<Result>)(
    req({}),
    PARAMS,
  );
  assert.equal(failed.status, 502);
  assert.equal((failed.body as { code?: string }).code, undefined, "no offline code when not offline");
});

// ---------------------------------------------------------------------------
// 3. LIB — the real purgeAdminDevice against the fake db
// ---------------------------------------------------------------------------

test("purge: an unknown device → device_not_found, nothing touched", async () => {
  await assert.rejects(() => purgeLib().purgeAdminDevice({ deviceId: "dev_missing" }), /device_not_found/);
  assert.deepEqual(ops, [], "no remote call, no frames, no transaction");
  assert.equal(ensureCalls.length, 0);
  assert.equal(frameCalls.length, 0);
});

test("purge: a LIVE row → device_not_deleted, and every guard fires before anything destructive", async () => {
  seedPurgeDevice({ removedAt: null });
  await assert.rejects(() => purgeLib().purgeAdminDevice({ deviceId: "dev_1" }), /device_not_deleted/);
  assert.deepEqual(ops, [], "not one step ran");
  assert.equal(ensureCalls.length, 0, "not even the remote half — refusal is first");
  assert.equal(frameCalls.length, 0);
  assert.equal(purgeStore.devices.length, 1, "the row survives");
});

test("purge (success): remote → frames → ONE transaction with device.delete LAST", async () => {
  seedPurgeDevice();
  const result = await purgeLib().purgeAdminDevice({ deviceId: "dev_1" });

  assert.deepEqual(ops, [
    "ensure",
    "frames:dev_1",
    "tx:start",
    "deviceRelationship.deleteMany",
    "cloneJob.deleteMany",
    "hostedBrowserSession.deleteMany",
    "relayHealth.deleteMany",
    "devicePowerPolicy.deleteMany",
    "deviceQueuedCommand.deleteMany",
    "devicePinRequest.deleteMany",
    "deviceCapability.deleteMany",
    "deviceHeartbeat.deleteMany",
    "deviceJob.deleteMany",
    "deviceAction.deleteMany",
    "deviceAudit.deleteMany",
    "device.delete",
    "tx:end",
  ]);

  // The relationship covers BOTH directions — the row may be a clone's source
  // or its target.
  const rel = txSteps.find((s) => s.op === "deviceRelationship.deleteMany");
  assert.deepEqual(
    (rel?.args as { where: { OR: unknown[] } }).where.OR,
    [{ sourceDeviceId: "dev_1" }, { targetDeviceId: "dev_1" }],
  );
  // device.delete is inside the transaction, after all 12 children.
  assert.equal(txSteps[txSteps.length - 1].op, "device.delete");

  assert.deepEqual(ensureCalls, [{ userId: "u_owner", agentId: "agent_1" }]);
  assert.deepEqual(frameCalls, ["dev_1"], "the frame tree goes before the rows");
  assert.equal(purgeStore.devices.length, 0, "the row is really gone");
  assert.equal(result.id, "dev_1");
  assert.equal(result.agentRemoved, true, "this purge's remote step removed the agent");
  assert.equal(result.owner.id, "u_owner");
});

test("purge: no vantraAgentId → the remote step is skipped, purge still runs", async () => {
  seedPurgeDevice({ vantraAgentId: null });
  const result = await purgeLib().purgeAdminDevice({ deviceId: "dev_1" });
  assert.equal(ensureCalls.length, 0, "nothing to uninstall — and nothing to resurrect from");
  assert.deepEqual(ops[0], "frames:dev_1", "straight to disk cleanup");
  assert.equal(result.agentRemoved, false);
  assert.equal(purgeStore.devices.length, 0);
});

test("purge: a resurrection guard that says NO aborts before frames and rows", async () => {
  seedPurgeDevice();
  ensureBehavior = { kind: "throw", code: "agent_still_active" };
  await assert.rejects(
    () => purgeLib().purgeAdminDevice({ deviceId: "dev_1" }),
    /agent_still_active/,
  );
  assert.equal(ensureCalls.length, 1);
  assert.deepEqual(ops, ["ensure"], "nothing after the guard — frames and transaction never ran");
  assert.equal(frameCalls.length, 0, "captures are untouched");
  assert.equal(purgeStore.devices.length, 1, "the row survives for a retry");
});

test("purge: an agent already gone upstream (guard returns false) still purges, agentRemoved: false", async () => {
  seedPurgeDevice();
  ensureBehavior = { kind: "return", value: false };
  const result = await purgeLib().purgeAdminDevice({ deviceId: "dev_1" });
  assert.equal(result.agentRemoved, false, "WE didn't remove it this time — it was already gone");
  assert.equal(purgeStore.devices.length, 0, "and the purge completed");
  assert.equal(ops[ops.length - 1], "tx:end");
});

// ---------------------------------------------------------------------------
// 4. STATIC LOCKS — both UIs
// ---------------------------------------------------------------------------

test("device-list: the offline dialog is gone, the silent fallback stays, and no recovery word leaks", () => {
  const src = read("components/device-list.tsx");
  assert.ok(!src.includes("Hide from list anyway"), "the hide-anyway dialog is gone");
  assert.ok(!src.includes("hide it from this list instead"), "…and its description with it");
  assert.ok(!src.includes("Couldn't remove ${"), "no per-device failure dialog for agent_offline");
  assert.ok(!src.includes("Recover"), "no recovery vocabulary on a customer surface");
  assert.ok(!/history \(sessions, activity\)/.test(src), "the 'history is kept' promise is gone");
  assert.ok(
    src.includes('data.error === "agent_offline"'),
    "the offline answer is still handled — silently",
  );
  assert.ok(src.includes("?local=1"), "…by the documented local fallback");
});

test("devices-tab: both admin actions are wired — purge + move, each to its route", () => {
  const src = read("components/admin/devices-tab.tsx");
  assert.ok(src.includes("Delete permanently"), "the Deleted subtab's final button");
  assert.ok(src.includes("/purge"), "…pointing at the purge route");
  assert.ok(src.includes("Move to Deleted"), "the active row's soft-delete menu item");
  assert.ok(src.includes("/remove"), "…pointing at the remove route");
  assert.ok(src.includes("useConfirm()"), "both destructive actions confirm first");
});
