import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// 2026-09-28 — device presence semantics (owner report: "it takes long for the
// active to turn off, I tried pinging this agent and it was not reachable").
//
// WHY THIS FILE EXISTS: the console showed "online · active now" while the very
// same screen's Ping button said "Agent not reachable". `pingDevice()` asks the
// agent directly (truth), but the status BADGE was derived purely from
// `lastSeenAt` age via `deviceStatus()`, so a machine switched off a minute ago
// stayed green for up to 10 minutes. These tests pin the rule: a stored
// "offline" verdict is authoritative and must be honoured immediately, while
// "online"/"asleep"/unknown still have to prove freshness through the window
// (which is what ages out a device that simply vanished).
//
// The module under test is the REAL `lib/devices.ts` — not a copy of its logic
// — loaded through the house require hook (HOW_WE_MOVE_FAST §4) that swaps only
// its own two dependencies for the smallest possible stand-ins. `db` is never
// touched by the functions under test (they are pure), so the stub is inert on
// purpose: if a future change makes these functions hit the database, that is a
// design change the test should not paper over.

process.env.DATABASE_URL = "postgresql://t_devstatus:dev@localhost:5432/placeholder";
process.env.SESSION_SECRET = "device-status-test-session-secret";

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    // `lib/devices.ts` is server-only and imports the prisma singleton; the
    // functions under test are pure, so both are stubbed and nothing else is.
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
/** A timestamp `minutes` ago (fractional allowed). */
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

test("a stored offline verdict is honoured immediately, even with a fresh lastSeenAt", () => {
  // THE REGRESSION: Vantra had just reported the machine gone, `lastSeenAt` was
  // 10 seconds old, and the sidebar still read "online · active now".
  assert.equal(devices.deviceStatus({ status: "offline", lastSeenAt: ago(10 / 60) }), "offline");
  assert.equal(devices.deviceStatus({ status: "offline", lastSeenAt: new Date() }), "offline");
});

test("an online verdict still has to prove freshness, so a vanished device ages out", () => {
  assert.equal(devices.deviceStatus({ status: "online", lastSeenAt: ago(10 / 60) }), "online");
  assert.equal(devices.deviceStatus({ status: "online", lastSeenAt: ago(9) }), "online");
  // No verdict refresh (Vantra unreachable / list never opened) -> the window
  // itself has to turn it off, or a crashed box would stay green forever.
  assert.equal(devices.deviceStatus({ status: "online", lastSeenAt: ago(20) }), "offline");
  assert.equal(devices.deviceStatus({ status: "online", lastSeenAt: null }), "offline");
});

test("asleep keeps its own meaning: a deliberate sleep survives going stale", () => {
  assert.equal(devices.deviceStatus({ status: "asleep", lastSeenAt: ago(20) }), "asleep");
  assert.equal(devices.deviceStatus({ status: "asleep", lastSeenAt: null }), "asleep");
  // ...but a live heartbeat proves the machine woke up.
  assert.equal(devices.deviceStatus({ status: "asleep", lastSeenAt: ago(1) }), "online");
});

test("an unknown status falls back to the age window, never a bare 'online'", () => {
  assert.equal(devices.deviceStatus({ status: "unknown", lastSeenAt: ago(1) }), "online");
  assert.equal(devices.deviceStatus({ status: "unknown", lastSeenAt: ago(20) }), "offline");
});

test("isDeviceOnline is the single age rule every freshness check shares", () => {
  assert.equal(devices.isDeviceOnline(null), false);
  assert.equal(devices.isDeviceOnline(ago(0)), true);
  assert.equal(devices.isDeviceOnline(ago(9)), true);
  // The window is exclusive at exactly 10 minutes, matching the old behaviour.
  assert.equal(devices.isDeviceOnline(ago(10)), false);
  assert.equal(devices.isDeviceOnline(ago(60)), false);
});

test("toDeviceView carries the verdict through as effectiveStatus", () => {
  // `app/api/devices/route.ts` maps every row through this, and the device
  // console reads `effectiveStatus` in preference to `status` — so this is the
  // value the badge actually renders.
  const view = devices.toDeviceView({
    status: "offline",
    lastSeenAt: ago(10 / 60),
  } as unknown as Parameters<typeof devices.toDeviceView>[0]);
  assert.equal(view.effectiveStatus, "offline");
});
