import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_185 P2 — the overview row must count EXACTLY what the device list shows.
//
// THE LIVE DEFECT (owner 2026-10-08): dashboard said "4 online of 9" while the
// Devices page listed 2 with none online. psql proved three causes in the old
// counts (`app/api/overview-stats/route.ts`):
//   1. no `removedAt` filter — 6 soft-deleted rows still counted;
//   2. no `deviceKind` filter — the "hosted" clone-destination row counted;
//   3. `status: "online"` — set at heartbeat time and never aged, so 4 rows
//      claimed online while 0 were inside the 10-minute window.
// This file pins the FIX: both counts carry the same filters GET /api/devices
// serves, and online is the last-seen WINDOW, never the status column.
//
// House require-hook pattern (HOW_WE_MOVE_FAST §4): the REAL route module is
// required; only its own imports are swapped. No DB, no network.

(process.env as Record<string, string>).NODE_ENV = "test";

const MIN = 60_000;
/** Captured `where` objects, in call order: [total, online]. */
const deviceWheres: Array<Record<string, unknown>> = [];

const fakeDb = {
  user: {
    findUnique: async () => ({ balanceCents: 500, postpaidLimitCents: 0 }),
  },
  device: {
    count: async ({ where }: { where: Record<string, unknown> }) => {
      deviceWheres.push(where);
      return deviceWheres.length;
    },
  },
  lead: { count: async () => 0 },
  emailCampaign: { count: async () => 0 },
  mailbox: { count: async () => 0 },
};

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/app/api/overview-stats/route.ts")) {
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
      if (request === "@/lib/db") return { db: fakeDb };
      if (request === "@/lib/session-user") {
        return {
          getCurrentUser: async () => ({ id: "u-overview", aiDailyCapHundredthsCent: 1000 }),
        };
      }
      if (request === "@/lib/rate-limit") {
        return { allowAndRecord: async () => true, getClientIp: async () => "127.0.0.1" };
      }
      if (request === "@/lib/ai-metering") {
        return { getUsedAiTodayHundredthsCent: async () => 0 };
      }
      // The SAME window the device list uses (real value; the module itself is
      // db-backed, so the constant is provided directly here).
      if (request === "@/lib/devices") return { DEVICE_ONLINE_WINDOW_MS: 10 * MIN };
    }
    return original.call(this, request, parent, isMain);
  };
}

installRequireHook();

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("../app/api/overview-stats/route") as {
  GET: () => Promise<{ status: number; body: { counts: Record<string, number> } }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

test("P2: both device counts exclude soft-deleted and hosted rows", async () => {
  deviceWheres.length = 0;
  const res = await route.GET();
  assert.equal(res.status, 200);
  assert.equal(deviceWheres.length, 2, "total + online are the two device counts");
  const [total, online] = deviceWheres;
  for (const [i, w] of [total, online].entries()) {
    assert.equal(w.userId, "u-overview", `count ${i} is scoped to the session user`);
    assert.deepEqual(w.removedAt, null, `count ${i} must exclude soft-deleted devices`);
    assert.deepEqual(w.deviceKind, { not: "hosted" }, `count ${i} must exclude the hosted clone PC`);
  }
  assert.equal(res.body.counts.devicesTotal, 1);
  assert.equal(res.body.counts.devicesOnline, 2);
});

test("P2: online is the 10-minute last-seen window, never the stale status column", async () => {
  deviceWheres.length = 0;
  const before = Date.now();
  await route.GET();
  const online = deviceWheres[1];

  assert.ok(!("status" in online), "the status column must not be trusted for online");
  assert.ok(!("lastSeenAt" in deviceWheres[0]), "the total count needs no last-seen bound");

  const bound = online.lastSeenAt as { gte: Date };
  assert.ok(bound && bound.gte instanceof Date, "online must bound lastSeenAt");
  const ageMs = Date.now() - bound.gte.getTime();
  // gte == now - 10min (± the tiny test runtime).
  assert.ok(ageMs >= 10 * MIN - 5_000 && ageMs <= 10 * MIN + 5_000, `window must be 10 min, was ${ageMs}ms`);
  assert.ok(before - bound.gte.getTime() <= 10 * MIN + 5_000);
});