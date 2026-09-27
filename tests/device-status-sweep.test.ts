import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_129 — the device-status sweep's own two-sided contract:
//   1. CONFIGURED (VANTRA_INTERNAL_URL + VANTRA_INTERNAL_TOKEN set, as every
//      hosted deploy has them) → it runs exactly as before: compare each
//      device's live state to lastNotifiedOnline, notify only on a genuine
//      transition, and record the new state.
//   2. NOT CONFIGURED (a self-hosted deploy with no internal device-check-in
//      service) → no-op cleanly with a 200 and a `skipped` marker, without
//      touching the device table or erroring every 5-minute timer fire.
//
// The unit under test is the REAL route (app/api/internal/device-status-sweep/
// route.ts) loaded through the house require hook (HOW_WE_MOVE_FAST.md §4),
// swapping only its own dependencies for recording fakes. Nothing here touches
// a real database or the network.
process.env.VANTRA_INTERNAL_URL = "https://vantra.spaceworker.test";
process.env.VANTRA_INTERNAL_TOKEN = "task129-test-internal-token";

interface DeviceRow {
  id: string;
  name: string;
  userId: string;
  lastSeenAt: Date | null;
  lastNotifiedOnline: boolean | null;
  notifyDeviceOffline: boolean;
  notifyDeviceOnline: boolean;
}

let devices: DeviceRow[] = [];
let findManyCalls = 0;
let updates: Array<{ id: string; lastNotifiedOnline: boolean }> = [];
let notifyCalls: Array<{ userId: string; eventType: string; subject: string }> = [];
let bearerOk = true;

const fakePrisma = {
  device: {
    async findMany() {
      findManyCalls += 1;
      return devices.map((d) => ({
        id: d.id,
        name: d.name,
        userId: d.userId,
        lastSeenAt: d.lastSeenAt,
        lastNotifiedOnline: d.lastNotifiedOnline,
        user: {
          notifyDeviceOffline: d.notifyDeviceOffline,
          notifyDeviceOnline: d.notifyDeviceOnline,
        },
      }));
    },
    async update(args: { where: { id: string }; data: { lastNotifiedOnline: boolean } }) {
      updates.push({ id: args.where.id, lastNotifiedOnline: args.data.lastNotifiedOnline });
      return { ...args.data };
    },
  },
};

const fakeNotifyUser = async (userId: string, payload: { eventType: string; subject: string }) => {
  notifyCalls.push({ userId, eventType: payload.eventType, subject: payload.subject });
};

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

const ROUTE = "app/api/internal/device-status-sweep/route.ts";

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith(`/${ROUTE}`)) {
      if (request === "next/server") {
        return {
          NextResponse: {
            json: (body: unknown, init?: { status?: number }) => ({
              status: init?.status ?? 200,
              body,
              json: async () => body,
            }),
          },
        };
      }
      if (request === "@/lib/prisma") return { prisma: fakePrisma };
      if (request === "@/lib/internal-auth") return { requireInternalBearer: () => bearerOk };
      if (request === "@/lib/devices") {
        return {
          isDeviceOnline: (d: Date | null) => !!d && Date.now() - d.getTime() < 10 * 60_000,
        };
      }
      if (request === "@/lib/notify") return { notifyUser: fakeNotifyUser };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();
/* eslint-disable @typescript-eslint/no-require-imports */
const routeModule = require("../app/api/internal/device-status-sweep/route") as {
  POST: (req: Request) => Promise<{ status: number; body: SweepBody }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

type SweepBody = {
  ok?: boolean;
  skipped?: string;
  checked: number;
  notified: number;
};

function post(): Promise<{ status: number; body: SweepBody }> {
  return routeModule.POST(
    new Request("https://spaceworker.test/api/internal/device-status-sweep", { method: "POST" }),
  );
}

function addDevice(over: Partial<DeviceRow> = {}): DeviceRow {
  const device: DeviceRow = {
    id: "dev_1",
    name: "Device 1",
    userId: "user_1",
    lastSeenAt: new Date(),
    lastNotifiedOnline: null,
    notifyDeviceOffline: true,
    notifyDeviceOnline: true,
    ...over,
  };
  devices.push(device);
  return device;
}

beforeEach(() => {
  devices = [];
  findManyCalls = 0;
  updates = [];
  notifyCalls = [];
  bearerOk = true;
});

test("a genuine offline -> online transition notifies once and records the new state", async () => {
  addDevice({ lastNotifiedOnline: false, lastSeenAt: new Date(), notifyDeviceOnline: true });
  const res = await post();
  assert.equal(res.status, 200);
  assert.equal(res.body.checked, 1);
  assert.equal(res.body.notified, 1);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0].eventType, "device_online");
  assert.deepEqual(updates, [{ id: "dev_1", lastNotifiedOnline: true }]);
});

test("TASK_129: no-ops cleanly when device management is not configured", async () => {
  const savedUrl = process.env.VANTRA_INTERNAL_URL;
  const savedToken = process.env.VANTRA_INTERNAL_TOKEN;
  delete process.env.VANTRA_INTERNAL_URL;
  delete process.env.VANTRA_INTERNAL_TOKEN;
  try {
    addDevice({ lastNotifiedOnline: false, lastSeenAt: new Date() });
    const res = await post();
    assert.equal(res.status, 200, "must be a clean 200, not a 4xx/5xx");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.skipped, "device management not configured");
    assert.equal(findManyCalls, 0, "must not read the device table when not configured");
    assert.equal(notifyCalls.length, 0);
  } finally {
    process.env.VANTRA_INTERNAL_URL = savedUrl;
    process.env.VANTRA_INTERNAL_TOKEN = savedToken;
  }
});
