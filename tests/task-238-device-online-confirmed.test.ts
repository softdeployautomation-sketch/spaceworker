import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_238 — the false-offline bug (owner report: a machine Vantra reports
// ONLINE shows as offline in the console, so clone/screenshot/WOL refuse it).
//
// WHY THIS FILE EXISTS: `deviceStatus()` used to prove liveness ONLY through
// `lastSeenAt` (a heartbeat within 5 min). Vantra omits `lastSeen` for some
// online agents, and 29a4483 correctly stopped fabricating it — so those rows
// sat at `status='online'` with a stale/null heartbeat and read "offline"
// forever (verified on the prod DB: online rows 2h/7h/8h stale).
//
// The fix is a SECOND freshness anchor: `Device.onlineConfirmedAt`, stamped by
// `syncDevices()` whenever Vantra says online (and cleared when it says
// offline). `lastSeenAt` keeps its exact meaning — no invented heartbeats.
// This file pins the resulting truth table and the two windows, including the
// 5-minute heartbeat window the rejected task-agent attempt tried to widen.
//
// The module under test is the REAL `lib/devices.ts` (house require hook,
// HOW_WE_MOVE_FAST §4): `server-only` and the prisma singleton are stubbed;
// nothing else is. The functions are pure, so `db` is inert on purpose.

process.env.DATABASE_URL = "postgresql://t_t238:dev@localhost:5432/placeholder";
process.env.SESSION_SECRET = "task-238-test-session-secret";
process.env.APP_BASE_URL = "https://spaceworker.test";
process.env.EMAIL_FROM = "t238@spaceworker.test";
process.env.RESEND_API_KEY = "re_task238_test";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    if (from.endsWith("/lib/devices.ts") || from.endsWith("/lib/devices")) {
      if (request === "./db") return { db: {} };
    }
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const devices = require("../lib/devices") as typeof import("../lib/devices");
/* eslint-enable @typescript-eslint/no-require-imports */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

test("TASK_238 — an online verdict rescues a device whose lastSeen is stale or missing", () => {
  // THE REGRESSION: Vantra said online, `lastSeenAt` was hours old (or absent),
  // and every consumer called the machine offline.
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: ago(8 * 60 * MIN), onlineConfirmedAt: ago(10_000) }),
    "online",
  );
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: null, onlineConfirmedAt: ago(10_000) }),
    "online",
  );
});

test("TASK_238 — a fresh heartbeat alone still proves online (no verdict needed)", () => {
  assert.equal(devices.deviceStatus({ status: "online", lastSeenAt: ago(30_000) }), "online");
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: ago(30_000), onlineConfirmedAt: ago(10 * MIN) }),
    "online",
  );
});

test("TASK_238 — a stale verdict and a stale heartbeat age out together", () => {
  // A stopped sync must not keep a dead machine green forever: 29a4483's lesson.
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: ago(2 * 60 * MIN), onlineConfirmedAt: ago(2 * MIN) }),
    "offline",
  );
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: null, onlineConfirmedAt: null }),
    "offline",
  );
});

test("TASK_238 — the verdict window is 60s, far shorter than the 5-minute heartbeat window", () => {
  assert.equal(devices.VERDICT_FRESH_MS, 60_000);
  assert.equal(devices.DEVICE_ONLINE_WINDOW_MS, 5 * MIN, "the rejected 10-minute widening must not return");
  assert.equal(devices.isVerdictFresh(ago(59_000)), true);
  assert.equal(devices.isVerdictFresh(ago(61_000)), false);
  assert.equal(devices.isVerdictFresh(null), false);
  assert.equal(devices.isVerdictFresh(undefined), false);
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: null, onlineConfirmedAt: ago(59_000) }),
    "online",
  );
  assert.equal(
    devices.deviceStatus({ status: "online", lastSeenAt: null, onlineConfirmedAt: ago(61_000) }),
    "offline",
  );
});

test("TASK_238 — an offline verdict is authoritative even with a fresh anchor", () => {
  // Vantra said gone; the old anchor must not resurrect it (the badge and Ping
  // disagreed for up to 5 minutes before this rule existed).
  assert.equal(
    devices.deviceStatus({ status: "offline", lastSeenAt: new Date(), onlineConfirmedAt: ago(5_000) }),
    "offline",
  );
});

test("TASK_238 — a verdict does not wake an intentional sleep; a heartbeat does", () => {
  // `asleep` is a deliberate state, not a freshness question. Only a real
  // heartbeat proves the machine woke up.
  assert.equal(
    devices.deviceStatus({ status: "asleep", lastSeenAt: ago(2 * 60 * MIN), onlineConfirmedAt: ago(5_000) }),
    "asleep",
  );
  assert.equal(
    devices.deviceStatus({ status: "asleep", lastSeenAt: ago(30_000), onlineConfirmedAt: null }),
    "online",
  );
});

test("TASK_238 — an unknown status may still use the verdict, never a bare 'online'", () => {
  assert.equal(
    devices.deviceStatus({ status: "unknown", lastSeenAt: null, onlineConfirmedAt: ago(10_000) }),
    "online",
  );
  assert.equal(
    devices.deviceStatus({ status: "unknown", lastSeenAt: null, onlineConfirmedAt: ago(2 * MIN) }),
    "offline",
  );
});

test("TASK_238 — the selector carries the new column, so no caller has to re-select it", () => {
  assert.equal(devices.deviceListSelector.onlineConfirmedAt, true);
  assert.equal(devices.deviceListSelector.lastSeenAt, true);
});
