import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_188 — THE GATE AT THE ROUTE + the query/mutation semantics, end to end.
//
// Three layers, each proving the thing the layer above it cannot:
//   1. ROUTES  — restore is 403 without an admin session, `?removed=1` is gated
//                behind the same session, an unknown target user is refused.
//   2. LIB     — against a fake db: the DEFAULT list still filters
//                `removedAt: null`, `removed: true` inverts exactly that one
//                clause, and restore writes `removedAt: null` EXPLICITLY (the
//                P4 rule: the Vantra sync never clears it, so nothing may rely
//                on it to) plus the reassignment when `userId` is given.
//   3. STATIC  — the Devices tab + its "View devices →" jump are gone from the
//                admin panel, the retired `app/admin/` tree no longer exists
//                (S6: the admin site moved), the proxy gates the new root, and
//                nothing anywhere links the private devices URL.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const RESTORE_ROUTE = "/app/api/admin/devices/[deviceId]/restore/route.ts";
const LIST_ROUTE = "/app/api/admin/devices/route.ts";
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
// Fake db — the tables the device layer touches. The recorders are the
// assertions: a filter that silently stops filtering, or a mutation that
// writes the wrong column, shows up here even when the return value looks
// right.
// ---------------------------------------------------------------------------
interface FakeDevice {
  id: string;
  userId: string;
  name: string;
  removedAt: Date | null;
}

const store: { devices: FakeDevice[]; users: Array<{ id: string }> } = {
  devices: [],
  users: [],
};

const calls: {
  findManyWhere: Record<string, unknown> | null;
  updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
} = { findManyWhere: null, updates: [] };

const fakeDb = {
  device: {
    findMany: async (args: { where: Record<string, unknown> }) => {
      calls.findManyWhere = args.where;
      // Shape must satisfy ADMIN_DEVICE_SELECT + the row mapping in
      // listAdminDevices (the status derivation reads `.status`/`.lastSeenAt`).
      return store.devices.map((d) => ({
        id: d.id,
        userId: d.userId,
        name: d.name,
        deviceKind: "desktop",
        status: "online",
        osName: "Windows",
        osVersion: "11",
        tier: "public",
        lastSeenAt: new Date(),
        createdAt: new Date(),
        removedAt: d.removedAt,
        vantraAgentId: "agent_1",
        user: { id: d.userId, email: "owner@example.com", tier: 1 },
      }));
    },
    findUnique: async (args: { where: { id: string } }) => {
      const d = store.devices.find((x) => x.id === args.where.id);
      if (!d) return null;
      return { id: d.id, name: d.name, userId: d.userId, removedAt: d.removedAt };
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      calls.updates.push({ where: args.where, data: args.data });
      const d = store.devices.find((x) => x.id === args.where.id);
      if (!d) throw new Error("device_not_found");
      if ("removedAt" in args.data) d.removedAt = args.data.removedAt as Date | null;
      if (typeof args.data.userId === "string") d.userId = args.data.userId;
      return {
        id: d.id,
        name: d.name,
        removedAt: d.removedAt,
        user: { id: d.userId, email: "owner@example.com", tier: 1 },
      };
    },
  },
  user: {
    findUnique: async (args: { where: { id: string } }) =>
      store.users.find((u) => u.id === args.where.id) ?? null,
    findMany: async () => store.users,
  },
};

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
  // lib/admin-devices.ts pulls four relative deps — all four must resolve to
  // the fakes above, or the "real" module would open a real db handle in a
  // unit test.
  if (from.endsWith("/lib/admin-devices.ts")) {
    if (request === "./db") return { db: fakeDb };
    if (request === "./devices")
      return { deviceStatus: (r: { status?: string }) => r.status ?? "offline" };
    if (request === "./device-tools") return { adminRunDeviceCommand: async () => ({}) };
    if (request === "./vantra-link") return { fetchUserIdle: async () => ({}) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

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

// The admin session each scenario answers with (null ⇒ the 403 path).
let adminValue: { sub: string } | null;
const ADMIN_DEP = {
  getAdminSession: async () => adminValue,
  requireAdminSession: async () => adminValue !== null,
};

const listCalls: Array<Record<string, unknown>> = [];
let listResult: { devices: unknown[]; truncated: boolean } = { devices: [], truncated: false };
const LIST_DEP = {
  listAdminDevices: async (opts: Record<string, unknown>) => {
    listCalls.push(opts);
    return listResult;
  },
};

const restoreCalls: Array<{ deviceId: string; userId?: string }> = [];
let restoreThrows: string | null = null;
const RESTORE_DEP = {
  restoreAdminDevice: async (opts: { deviceId: string; userId?: string }) => {
    restoreCalls.push(opts);
    if (restoreThrows) throw new Error(restoreThrows);
    return {
      id: opts.deviceId,
      name: "Box",
      removedAt: null,
      owner: { id: "u_target", email: "t@example.com", tier: 1 },
    };
  },
};

const auditCalls: Array<Record<string, unknown>> = [];
const AUDIT_DEP = {
  recordAgentActionAudit: async (opts: Record<string, unknown>) => void auditCalls.push(opts),
};

const PARAMS = { params: Promise.resolve({ deviceId: "dev_1" }) };
const req = (body: unknown) => ({ json: async () => body }) as never;
const plainReq = () => ({ url: "http://x/api/admin/devices" }) as unknown as Request;
const flaggedReq = () =>
  ({ url: "http://x/api/admin/devices?removed=1" }) as unknown as Request;

function seedDevice(row: Partial<FakeDevice> = {}): void {
  store.devices.push({ id: "dev_1", userId: "u_owner", name: "Box", removedAt: null, ...row });
}

beforeEach(() => {
  store.devices.length = 0;
  store.users.length = 0;
  calls.findManyWhere = null;
  calls.updates.length = 0;
  listCalls.length = 0;
  restoreCalls.length = 0;
  auditCalls.length = 0;
  restoreThrows = null;
  listResult = { devices: [], truncated: false };
  adminValue = { sub: "admin" };
  overrides = {};
});

// ---------------------------------------------------------------------------
// 1. ROUTES
// ---------------------------------------------------------------------------

test("restore → 403 without an admin session; nothing is written", async () => {
  adminValue = null;
  const route = loadFresh(RESTORE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": RESTORE_DEP,
    "@/lib/devices": AUDIT_DEP,
  });
  const res = await (route.PATCH as (r: unknown, c: unknown) => Promise<Result>)(
    req({ userId: "u_target" }),
    PARAMS,
  );
  assert.equal(res.status, 403);
  assert.equal(restoreCalls.length, 0, "the mutation must never be reached");
  assert.equal(auditCalls.length, 0);
});

test("GET list → 403 without an admin session, before any query", async () => {
  adminValue = null;
  const route = loadFresh(LIST_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": LIST_DEP,
  });
  const res = await (route.GET as (r: unknown) => Promise<Result>)(plainReq());
  assert.equal(res.status, 403);
  assert.equal(listCalls.length, 0, "the list must never be assembled for a stranger");
});

test("removed=1 is admin-gated and reaches the lib as removed:true", async () => {
  const route = loadFresh(LIST_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": LIST_DEP,
  });
  const flagged = await (route.GET as (r: unknown) => Promise<Result>)(flaggedReq());
  assert.equal(flagged.status, 200);
  assert.equal(listCalls[0].removed, true, "the Deleted subtab's flag must reach the query");

  // DEFAULT (no flag) is unchanged: the caller never asks for deleted rows.
  listCalls.length = 0;
  const plain = await (route.GET as (r: unknown) => Promise<Result>)(plainReq());
  assert.equal(plain.status, 200);
  assert.notEqual(listCalls[0].removed, true, "an unflagged list must never ask for deleted rows");
});

test("restore with an unknown target user → 404 and no audit row", async () => {
  restoreThrows = "user_not_found";
  const route = loadFresh(RESTORE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": RESTORE_DEP,
    "@/lib/devices": AUDIT_DEP,
  });
  const res = await (route.PATCH as (r: unknown, c: unknown) => Promise<Result>)(
    req({ userId: "u_nope" }),
    PARAMS,
  );
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "Target user not found." });
  assert.equal(auditCalls.length, 0, "a refused restore must not claim to have happened");
});

test("restore with an admin session → lands on the target user's audit rail", async () => {
  const route = loadFresh(RESTORE_ROUTE, {
    "@/lib/admin-auth": ADMIN_DEP,
    "@/lib/admin-devices": RESTORE_DEP,
    "@/lib/devices": AUDIT_DEP,
  });
  const res = await (route.PATCH as (r: unknown, c: unknown) => Promise<Result>)(
    req({ userId: "u_target" }),
    PARAMS,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(restoreCalls[0], { deviceId: "dev_1", userId: "u_target" });
  assert.equal(auditCalls.length, 1, "the house pattern audits every admin mutation");
  assert.equal(auditCalls[0].action, "device_restored");
  assert.equal(auditCalls[0].approvalChannel, "admin");
  assert.equal(auditCalls[0].sourceDeviceId, "dev_1");
});

// ---------------------------------------------------------------------------
// 2. LIB — the real lib/admin-devices.ts against the fake db
// ---------------------------------------------------------------------------

function lib() {
  return loadFresh(ADMIN_DEVICES_LIB) as {
    listAdminDevices: (o?: Record<string, unknown>) => Promise<{ devices: unknown[] }>;
    restoreAdminDevice: (o: { deviceId: string; userId?: string }) => Promise<Record<string, unknown>>;
  };
}

test("DEFAULT list still excludes soft-deleted rows (removedAt: null stays in the where)", async () => {
  seedDevice();
  await lib().listAdminDevices({});
  assert.ok(calls.findManyWhere, "the query must have been issued");
  assert.equal(
    calls.findManyWhere?.removedAt,
    null,
    "the default must keep filtering removedAt: null",
  );
});

test("removed:true inverts exactly that clause — { not: null } — and nothing else", async () => {
  seedDevice({ removedAt: new Date() });
  const { devices } = await lib().listAdminDevices({ removed: true });
  assert.deepEqual(calls.findManyWhere?.removedAt, { not: null });
  assert.deepEqual(
    calls.findManyWhere?.deviceKind,
    { not: "hosted" },
    "the hosted exclusion is untouched",
  );
  assert.equal(devices.length, 1);
  assert.notEqual(
    (devices[0] as { removedAt: string | null }).removedAt,
    null,
    "the row carries its removedAt so the Deleted view can render it",
  );
});

test("restore writes removedAt: null EXPLICITLY (never via sync) and reassigns userId", async () => {
  seedDevice({ removedAt: new Date() });
  store.users.push({ id: "u_target" }, { id: "u_owner" });

  await lib().restoreAdminDevice({ deviceId: "dev_1", userId: "u_target" });

  assert.equal(calls.updates.length, 1);
  const data = calls.updates[0].data;
  assert.ok("removedAt" in data, "the clear must be written directly — P4 rule");
  assert.equal(data.removedAt, null, "removedAt: null, explicitly");
  assert.equal(data.userId, "u_target", "reassigned to the chosen user");
  assert.equal(store.devices[0].removedAt, null, "the row really left the Deleted list");
  assert.equal(store.devices[0].userId, "u_target");
});

test("restore with no userId keeps the original owner (recover in place)", async () => {
  seedDevice({ removedAt: new Date() });
  store.users.push({ id: "u_owner" });

  await lib().restoreAdminDevice({ deviceId: "dev_1" });

  assert.equal(calls.updates[0].data.removedAt, null);
  assert.equal("userId" in calls.updates[0].data, false, "no reassignment was asked for");
  assert.equal(store.devices[0].userId, "u_owner");
});

test("restore refuses an unknown device and an unknown target user — nothing is written", async () => {
  seedDevice({ removedAt: new Date() });

  await assert.rejects(
    () => lib().restoreAdminDevice({ deviceId: "dev_missing" }),
    /device_not_found/,
  );
  await assert.rejects(
    () => lib().restoreAdminDevice({ deviceId: "dev_1", userId: "u_ghost" }),
    /user_not_found/,
  );
  assert.equal(calls.updates.length, 0, "validation happens BEFORE any write");
  assert.ok(store.devices[0].removedAt instanceof Date, "the row is untouched");
});

// ---------------------------------------------------------------------------
// 3. STATIC LOCKS
// ---------------------------------------------------------------------------

test("admin panel: the devices tab entry and the 'View devices →' jump are gone", () => {
  const panel = read("app/admin=topsecret6199/(protected)/admin-panel.tsx");
  assert.ok(!panel.includes('id: "devices"'), "no devices tab button");
  assert.ok(
    !panel.includes('"devices" |') && !panel.includes('| "devices"'),
    "no devices member in the Tab union",
  );
  assert.ok(!panel.includes("<DevicesTab"), "the panel no longer renders the component");
  assert.ok(!panel.includes("View devices"), "the Users-tab jump is gone");
  assert.ok(!panel.includes("onViewDevices"), "and its prop wiring with it");
  // The component MOVED, it was not deleted — the private page owns it now.
  const extracted = read("components/admin/devices-tab.tsx");
  assert.ok(extracted.includes("export function DevicesTab"), "extracted + exported");
  assert.ok(
    read("app/admin=topsecret6199/device/101/host.tsx").includes("<DevicesTab"),
    "…and is rendered by the private page only",
  );
});

test("S6: the old app/admin tree is gone and the new root is gated by the proxy", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "app/admin")), "app/admin/ must not exist anymore");
  assert.ok(
    fs.existsSync(path.join(ROOT, "app/admin=topsecret6199/(protected)/page.tsx")),
    "the panel lives under the new root",
  );

  const proxy = read("proxy.ts");
  assert.ok(proxy.includes("/admin=topsecret6199"), "the proxy gates the new root");
  assert.ok(
    !proxy.includes('pathname.startsWith("/admin")'),
    "the retired prefix must not be treated as the admin tree (it would leak a redirect)",
  );
  assert.ok(
    !proxy.includes('"/admin/login"'),
    "…and the old login path is never named (no redirect can leak the new root)",
  );

  const guard = read("app/admin=topsecret6199/device/101/page.tsx");
  assert.ok(guard.includes("getAdminSession()"), "the private page carries its own session check");
  assert.ok(guard.includes("redirect("), "…and redirects without one");
});

test("secrecy: nothing links the private devices URL, and the panel never names the new root", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|json|txt|xml|html)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      // The route folder IS the URL's home — anything else naming it would be
      // a link to the secret page.
      const isRouteItself = full.includes(path.join("admin=topsecret6199", "device", "101"));
      if (!isRouteItself && text.includes("admin/device/101")) offenders.push(full);
      if (full.includes(`${path.sep}app${path.sep}dashboard`) && text.includes("topsecret6199")) {
        offenders.push(full);
      }
    }
  };
  for (const t of ["app", "components", "lib", "public"]) {
    const dir = path.join(ROOT, t);
    if (fs.existsSync(dir)) walk(dir);
  }
  assert.deepEqual(offenders, [], `the secret URL must not be referenced: ${offenders.join(", ")}`);

  const panel = read("app/admin=topsecret6199/(protected)/admin-panel.tsx");
  assert.ok(!panel.includes("topsecret6199"), "the admin panel never names the new root");
});
