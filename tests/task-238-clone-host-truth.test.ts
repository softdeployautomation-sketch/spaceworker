import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_238 — the clone host gate and the setup card must agree on the SAME
// definition of "online". Before this change `isUsable()` accepted the raw
// `status` column OR `deviceStatus()`, so a host could be "ready" here and then
// refused by `requireOnlineOwnedDevice()` with `device_offline`.
//
// The module under test is the REAL `lib/clone-hosts.ts` (house require hook,
// HOW_WE_MOVE_FAST §4): its db and vantra-link dependencies are stand-ins; the
// REAL `lib/devices.ts` is loaded, so the assertions are about the actual
// selector, not a copy. Nothing here touches a database or the network.

process.env.DATABASE_URL = "postgresql://t_t238h:dev@localhost:5432/placeholder";
process.env.SESSION_SECRET = "task-238-host-test-session-secret";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.EMAIL_FROM = "t238h@spaceworker.test";
process.env.RESEND_API_KEY = "re_task238h_test";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

type DeviceRow = {
  id: string;
  name: string;
  status: string;
  lastSeenAt: Date | null;
  onlineConfirmedAt: Date | null;
  deviceKind: string;
};

const HOUR = 60 * 60 * 1000;

// Filled per test; the fake delegate returns exactly these rows.
let hostRows: Array<{ device: DeviceRow }> = [];
let hostedRows: DeviceRow[] = [];

const fakeDb = {
  deviceCapability: {
    findMany: async () => hostRows,
  },
  device: {
    findMany: async () => hostedRows,
  },
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/devices.ts") && request === "./db") return { db: {} };
    if (from.endsWith("/lib/clone-hosts.ts")) {
      if (request === "./db") return { db: fakeDb };
      if (request === "./vantra-link") {
        return { syncDevices: async () => ({ devices: [] }) };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const hosts = require("../lib/clone-hosts") as typeof import("../lib/clone-hosts");
const devices = require("../lib/devices") as typeof import("../lib/devices");
/* eslint-enable @typescript-eslint/no-require-imports */

const host = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: "host-1",
  name: "Second PC",
  status: "online",
  lastSeenAt: new Date(Date.now() - 8 * HOUR),
  onlineConfirmedAt: new Date(),
  deviceKind: "workstation",
  ...over,
});

test("TASK_238 — a host with a stale heartbeat but a fresh verdict is usable", async () => {
  hostRows = [{ device: host() }];
  hostedRows = [];

  const availability = await hosts.hostAvailability({ userId: "u1", excludeDeviceId: "source" });

  assert.equal(availability.available, true);
  assert.equal(availability.reason, "ok");
  assert.equal(availability.pickedDeviceId, "host-1");
  assert.equal(availability.otherHostOnline, 1);
  assert.deepEqual(availability.offlineHostNames, []);
  // ...and that is exactly what the shared selector says about the row.
  assert.equal(devices.deviceStatus(hostRows[0].device), "online");
});

test("TASK_238 — both anchors stale means the host is offline, and the copy names it", async () => {
  hostRows = [{ device: host({ lastSeenAt: new Date(Date.now() - 8 * HOUR), onlineConfirmedAt: new Date(Date.now() - 5 * 60_000) }) }];
  hostedRows = [];

  const availability = await hosts.hostAvailability({ userId: "u1", excludeDeviceId: "source" });

  assert.equal(availability.available, false);
  assert.equal(availability.reason, "offline");
  assert.deepEqual(availability.offlineHostNames, ["Second PC"]);
  assert.equal(devices.deviceStatus(hostRows[0].device), "offline");
});

test("TASK_238 — a fresh heartbeat is still enough when the verdict is stale", async () => {
  hostRows = [{ device: host({ lastSeenAt: new Date(), onlineConfirmedAt: new Date(Date.now() - 5 * 60_000) }) }];
  hostedRows = [];

  const availability = await hosts.hostAvailability({ userId: "u1", excludeDeviceId: "source" });
  assert.equal(availability.available, true);
  assert.equal(availability.pickedDeviceId, "host-1");
});

test("TASK_238 — the hosted destination is judged by the same rule", async () => {
  hostRows = [];
  hostedRows = [
    host({
      id: "hosted-1",
      name: "Hosted browser",
      deviceKind: "hosted",
      lastSeenAt: null,
      onlineConfirmedAt: new Date(),
    }),
  ];

  const availability = await hosts.hostAvailability({ userId: "u1", excludeDeviceId: "source" });
  assert.equal(availability.available, true);
  assert.equal(availability.pickedDeviceId, "hosted-1");
});

test("TASK_238 — the gate and the selector cannot disagree across the matrix", async () => {
  const shapes: Array<Partial<DeviceRow>> = [
    { status: "online", lastSeenAt: null, onlineConfirmedAt: new Date() },
    { status: "online", lastSeenAt: null, onlineConfirmedAt: new Date(Date.now() - 5 * 60_000) },
    { status: "online", lastSeenAt: new Date(), onlineConfirmedAt: null },
    { status: "online", lastSeenAt: new Date(Date.now() - HOUR), onlineConfirmedAt: null },
    { status: "offline", lastSeenAt: new Date(), onlineConfirmedAt: new Date() },
    { status: "asleep", lastSeenAt: null, onlineConfirmedAt: new Date() },
    { status: "asleep", lastSeenAt: new Date(), onlineConfirmedAt: null },
  ];

  for (const shape of shapes) {
    const row = host(shape);
    hostRows = [{ device: row }];
    hostedRows = [];
    const availability = await hosts.hostAvailability({ userId: "u1", excludeDeviceId: "source" });
    const expected = devices.deviceStatus(row) === "online";
    assert.equal(
      availability.available,
      expected,
      `gate must match deviceStatus for ${JSON.stringify({ status: row.status, lastSeen: row.lastSeenAt && "set", verdict: row.onlineConfirmedAt && "set" })}`,
    );
  }
});
