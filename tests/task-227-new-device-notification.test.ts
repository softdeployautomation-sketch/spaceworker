import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_227 — the GATE for the "new device added" notification.
//
// WHY THIS FILE EXISTS: recordHeartbeat is the ONLY place a device joins an
// account (first sight of a Vantra agent id). Before this task the join was
// silent — the owner learned about a new machine only by noticing a new row in
// the device list. The contract pins here, layer by layer:
//   1. LIB    — against a fake db the REAL lib/devices.ts runs: the FIRST
//               heartbeat of a new vantraAgentId fires exactly ONE
//               notifyUser(device_added) with the device name interpolated;
//               every later heartbeat of the same device is silent; the
//               notifyDeviceAdded pref silences the ping WITHOUT blocking
//               device creation; a channel failure never fails the heartbeat
//               (try/catch best-effort — same shape as the device-status
//               sweep); and the master deviceTelemetryEnabled switch still
//               throws telemetry_disabled BEFORE any of this matters.
//   2. ROUTE  — PATCH /api/settings/notifications round-trips the new pref
//               (accepts false, returns it in prefs, persists via user.update)
//               and the refine still rejects an empty body.
//   3. STATIC — the sweep's `prev !== null` skip is still in place (the
//               device_added event must never be confused with the
//               offline/online verdict logic), the settings component renders
//               the toggle, and the settings page passes the pref through.
// ensureHostedDestination (the hosted clone pseudo-PC) creates Device rows but
// never registers a heartbeat, so it must stay silent — pinned here too.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://t_task227:dev@127.0.0.1:5432/placeholder";
process.env.SESSION_SECRET = "task227-test-session-secret";

const ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

// ---------------------------------------------------------------------------
// Fake state — reset in beforeEach. The notify recorder IS the assertion: a
// second send, a send on the update path, or a send while the pref is off all
// show up here even if the return value still looks right.
// ---------------------------------------------------------------------------
const hb = {
  owner: { id: "u1", deviceTelemetryEnabled: true, notifyDeviceAdded: true },
  created: [] as Array<Record<string, unknown>>,
  heartbeats: 0,
};

const notify = {
  calls: [] as Array<{ userId: string; opts: Record<string, unknown> }>,
  throws: false,
};

const clone = { created: [] as Array<Record<string, unknown>> };

const prefs = { updates: [] as Array<Record<string, unknown>> };

/** The tables recordHeartbeat touches. findUnique models reality: after a
 *  create, the same vantraAgentId resolves to the created row. */
const fakeDb = {
  user: { findUnique: async () => hb.owner },
  device: {
    findUnique: async ({ where }: { where: { vantraAgentId: string } }) =>
      hb.created.find((d) => d.vantraAgentId === where.vantraAgentId) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `dev-${hb.created.length + 1}`, ...data };
      hb.created.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = hb.created.find((d) => d.id === where.id) ?? { id: where.id };
      return { ...row, ...data };
    },
  },
  deviceHeartbeat: {
    create: async () => {
      hb.heartbeats += 1;
      return {};
    },
  },
};

const fakeCloneDb = {
  device: {
    findFirst: async () => null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: "hosted-1", ...data };
      clone.created.push(row);
      return row;
    },
  },
};

async function recordingNotifyUser(userId: string, opts: Record<string, unknown>): Promise<void> {
  if (notify.throws) throw new Error("channel_down");
  notify.calls.push({ userId, opts });
}

/** Minimal NextResponse stand-in — the route only ever returns `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

const fakeRouteDb = {
  user: {
    update: async ({ data }: { data: Record<string, unknown> }) => {
      prefs.updates.push(data);
      return {
        notifyEmail: true,
        notifyTelegram: false,
        notifyAgent: true,
        telegramApprovalsEnabled: true,
        telegramChatEnabled: false,
        digestEnabled: true,
        deviceTelemetryEnabled: true,
        agentActionsEnabled: true,
        notifyDeviceOffline: true,
        notifyDeviceOnline: true,
        notifyDeviceAdded: (data.notifyDeviceAdded as boolean | undefined) ?? true,
        agentWidgetEnabled: true,
        telegramChatId: null,
        telegramLinkToken: "tok-abc",
      };
    },
  },
};
function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/devices.ts") || from.endsWith("/lib/devices")) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./notify") return { notifyUser: recordingNotifyUser };
    }
    if (from.endsWith("/lib/clone-destination.ts") || from.endsWith("/lib/clone-destination")) {
      if (request === "./db") return { db: fakeCloneDb };
    }
    if (from.endsWith("/app/api/settings/notifications/route.ts")) {
      if (request === "@/lib/db") return { db: fakeRouteDb };
      if (request === "@/lib/session-user") return { getCurrentUser: async () => ({ id: "u1" }) };
      if (request === "@/lib/env") return { env: { telegramBotUsername: "" } };
      if (request === "@/lib/telegram") return { generateTelegramLinkToken: () => "tok-abc" };
    }
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const devices = require("../lib/devices") as typeof import("../lib/devices");
const { ensureHostedDestination } = require("../lib/clone-destination") as typeof import("../lib/clone-destination");
const { PATCH } = require("../app/api/settings/notifications/route") as typeof import("../app/api/settings/notifications/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const heartbeat = (vantraAgentId: string, name: string, extra: Record<string, unknown> = {}) =>
  devices.recordHeartbeat("u1", { vantraAgentId, name, ...extra });

beforeEach(() => {
  hb.owner = { id: "u1", deviceTelemetryEnabled: true, notifyDeviceAdded: true };
  hb.created = [];
  hb.heartbeats = 0;
  notify.calls = [];
  notify.throws = false;
  clone.created = [];
  prefs.updates = [];
});

test("the FIRST heartbeat of a new vantraAgentId fires exactly one device_added notification", async () => {
  const res = await heartbeat("agent-A", "Mike's MacBook", { osName: "macOS", osVersion: "15" });
  assert.equal(res.created, true);
  assert.equal(hb.created.length, 1);
  assert.equal(notify.calls.length, 1);
  const [call] = notify.calls;
  assert.ok(call);
  assert.equal(call.userId, "u1");
  assert.equal(call.opts.eventType, "device_added");
  assert.equal(call.opts.subject, "New device added: Mike's MacBook");
  assert.match(String(call.opts.emailHtml), /Mike's MacBook/);
  assert.match(String(call.opts.emailHtml), /macOS 15/);
  assert.match(String(call.opts.telegramText), /Mike's MacBook/);
});

test("every later heartbeat of the same device is silent — still exactly one notification total", async () => {
  const first = await heartbeat("agent-A", "Mike's MacBook");
  const second = await heartbeat("agent-A", "Mike's MacBook");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(hb.heartbeats, 2);
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0]?.opts.eventType, "device_added");
});

test("notifyDeviceAdded=false silences the ping WITHOUT blocking device creation", async () => {
  hb.owner = { id: "u1", deviceTelemetryEnabled: true, notifyDeviceAdded: false };
  const res = await heartbeat("agent-A", "Silent Box");
  assert.equal(res.created, true);
  assert.equal(hb.created.length, 1);
  assert.equal(hb.heartbeats, 1);
  assert.equal(notify.calls.length, 0);
});

test("a channel failure never fails the heartbeat (best-effort try/catch)", async () => {
  // THE REGRESSION THIS PINS: a dead Telegram token or email provider hiccup
  // must not turn a device registration into an HTTP 500 — the device row is
  // already written and the agent would retry forever against a hard failure.
  notify.throws = true;
  const res = await heartbeat("agent-A", "Flaky Channel", { osName: "Windows", osVersion: "11" });
  assert.equal(res.created, true);
  assert.equal(hb.created.length, 1);
  assert.equal(hb.heartbeats, 1);
});

test("the hosted clone destination stays silent — it never registers a heartbeat", async () => {
  const id = await ensureHostedDestination("u1");
  assert.equal(id, "hosted-1");
  assert.equal(clone.created.length, 1);
  // No Vantra agent by design (see clone-destination.ts header) — and no
  // notification, because it creates the row directly, never via heartbeat.
  assert.equal(clone.created[0]?.vantraAgentId, undefined);
  assert.equal(notify.calls.length, 0);
});

test("the MASTER telemetry switch still throws first — nothing created, nothing notified", async () => {
  hb.owner = { id: "u1", deviceTelemetryEnabled: false, notifyDeviceAdded: true };
  await assert.rejects(heartbeat("agent-A", "Blocked"), /telemetry_disabled/);
  assert.equal(hb.created.length, 0);
  assert.equal(hb.heartbeats, 0);
  assert.equal(notify.calls.length, 0);
});

test("PATCH /api/settings/notifications round-trips notifyDeviceAdded and still rejects an empty body", async () => {
  const req = { json: async () => ({ notifyDeviceAdded: false }) };
  const res = (await PATCH(req as unknown as Request)) as unknown as {
    status: number;
    body: { prefs: { notifyDeviceAdded: boolean } };
  };
  assert.equal(res.status, 200);
  assert.equal(res.body.prefs.notifyDeviceAdded, false);
  assert.equal(prefs.updates[0]?.notifyDeviceAdded, false);

  // The refine's "at least one field" contract survived the new field.
  const empty = (await PATCH({ json: async () => ({}) } as unknown as Request)) as unknown as {
    status: number;
    body: { error: string };
  };
  assert.equal(empty.status, 400);
});

test("static pins: sweep null-skip intact, toggle rendered, pref passed through the settings page", () => {
  // The sweep's prev !== null guard is what keeps a device_added event from
  // ever colliding with the offline/online verdict logic — pin it unchanged.
  const sweep = read("app/api/internal/device-status-sweep/route.ts");
  assert.match(sweep, /prev !== null/);

  const component = read("components/notifications-settings.tsx");
  assert.match(component, /notifyDeviceAdded/);
  assert.match(component, /New device added/);

  const page = read("app/dashboard/settings/page.tsx");
  assert.match(page, /notifyDeviceAdded: user\.notifyDeviceAdded/);
});