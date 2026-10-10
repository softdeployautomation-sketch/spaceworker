import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_191 S1 — tier-3 (XDevice) accounts must not see the quarantine flow.
//
// WHY THIS FILE EXISTS: a tier-3 account NEVER gets a private org
// (`isPrivateAllowed` in lib/vantra-link.ts returns false for reason "xdevice"),
// so the quarantine's end state (move to a private org) is unreachable for
// them — yet the sweep stages still run on their box and the device list showed
// the whole hide/stay-awake strip, row badge and stage wording. Owner's spec
// (2026-10-09): "take out that flow showing on the ui from xdevice users, so
// when a new device comes in, its just appears … it remains the same for
// premium plus". Clarified: UI ONLY — the sweep stages KEEP RUNNING silently.
//
// The module under test is the REAL `app/api/devices/route.ts` AND the REAL
// `lib/entitlements.ts` (its exported `isXdeviceLive` decides live-vs-lapsed
// tier 3) — loaded through the house require-hook (HOW_WE_MOVE_FAST §4) that
// swaps only the route's own dependencies for stand-ins. `lib/db` is swapped
// to an inert stub for the entitlements/premium chain because only the PURE
// function is called — if a future change makes that path query the database,
// the test should fail, not paper over it.

process.env.DATABASE_URL = "postgresql://t191:dev@localhost:5432/placeholder";
process.env.SESSION_SECRET = "task191-test-session-secret";

const MIN = 60_000;

let sessionValue: { userId: string } | null = null;
let userRow: { tier: number; premiumExpiresAt: Date | null } | null = null;
let deviceRows: Array<Record<string, unknown>> = [];
// TASK_198 — what the route's `resolveWrapperMode()` call sees (env/cookie
// scope). Reset per case in resetWorld so tests never leak into each other.
let wrapperScoped = false;

/** One device that IS mid-quarantine — the state tier-3 must never see. */
function resetWorld(tier: number, premiumExpiresAt: Date | null): void {
  sessionValue = { userId: "u-1" };
  userRow = { tier, premiumExpiresAt };
  wrapperScoped = false;
  deviceRows = [
    {
      id: "d-1",
      name: "M",
      status: "online",
      lastSeenAt: new Date(),
      onboarding: { status: "hiding", timerStartedAt: new Date(Date.now() - 6 * MIN) },
    },
  ];
}

const fakePrisma = {
  device: { findMany: async () => deviceRows },
  user: { findUnique: async () => userRow },
};

type Loader = {
  _load: (request: string, parent: NodeModule | undefined, isMain: boolean) => unknown;
};

function installRequireHook(): void {
  const loader = Module as unknown as Loader;
  const original = loader._load;
  loader._load = function patched(request, parent, isMain) {
    if (request === "server-only") return {};
    const from = (parent?.filename ?? "").replace(/\\/g, "/");
    // Real modules in the chain, inert DB: only `isXdeviceLive` (pure) runs.
    if (
      (from.endsWith("/lib/entitlements.ts") || from.endsWith("/lib/premium.ts")) &&
      request === "./db"
    ) {
      return { db: {} };
    }
    // The API boundary under test.
    if (from.endsWith("/app/api/devices/route.ts")) {
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
      if (request === "@/lib/session") return { getSession: async () => sessionValue };
      // TASK_198 — wrapper scope resolver, stubbed (the real one reads env +
      // next/headers; the route's OR-logic with isXdeviceLive is under test).
      if (request === "@/lib/wrapper-mode") {
        return { resolveWrapperMode: async () => (wrapperScoped ? "devices" : null) };
      }
      if (request === "@/lib/devices") {
        return {
          deviceListSelector: {},
          DEVICE_ONLINE_WINDOW_MS: 10 * MIN,
          isDeviceOnline: (lastSeenAt: Date | null) =>
            !!lastSeenAt && Date.now() - lastSeenAt.getTime() < 10 * MIN,
          toDeviceView: (d: Record<string, unknown>) => ({
            ...d,
            effectiveStatus: d.status,
            onboarding: d.onboarding ?? null,
          }),
        };
      }
      if (request === "@/lib/vantra-link") {
        return {
          fetchUserIdleReading: async () => ({
            asOf: new Date(),
            idleByHostname: {},
            idleByAgentId: {},
          }),
        };
      }
    }
    return original.call(this, request, parent, isMain);
  };
}

/* eslint-disable @typescript-eslint/no-require-imports */
installRequireHook();
const route = require("../app/api/devices/route") as {
  GET: (
    req: Request,
  ) => Promise<{ status: number; body: { devices: Array<Record<string, unknown>> } }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

async function get(): Promise<{
  status: number;
  body: { devices: Array<Record<string, unknown>> };
}> {
  return route.GET(new Request("http://localhost/api/devices"));
}

test("no session → 401 (unchanged)", async () => {
  resetWorld(3, null);
  sessionValue = null;
  assert.equal((await get()).status, 401);
});

test("live tier-3 (future term) → onboarding suppressed, payload field still present", async () => {
  resetWorld(3, new Date(Date.now() + 30 * 24 * 60 * MIN));
  const res = await get();
  assert.equal(res.status, 200);
  const row = res.body.devices[0];
  assert.ok("onboarding" in row, "the field must stay in the payload (shape back-compat)");
  assert.equal(row.onboarding, null, "tier-3 must not see the quarantine display");
});

test("grandfathered tier-3 (null expiry) → also suppressed", async () => {
  resetWorld(3, null);
  assert.equal((await get()).body.devices[0].onboarding, null);
});

test("lapsed tier-3 term → reverts to normal behaviour, display KEPT", async () => {
  resetWorld(3, new Date(Date.now() - MIN));
  const onboarding = (await get()).body.devices[0].onboarding;
  assert.ok(onboarding, "an expired term behaves like free — the display stays");
  assert.equal((onboarding as { isOnline: boolean }).isOnline, true);
});

test("tier-5 (Premium Plus) → display KEPT exactly as before", async () => {
  resetWorld(5, new Date(Date.now() + 60 * 24 * 60 * MIN));
  assert.ok((await get()).body.devices[0].onboarding);
});

test("free tier-1 → display KEPT (owner only named xdevice)", async () => {
  resetWorld(1, null);
  assert.ok((await get()).body.devices[0].onboarding);
});

test("device with no onboarding row stays null for everyone (shape unchanged)", async () => {
  resetWorld(5, null);
  deviceRows[0].onboarding = null;
  assert.equal((await get()).body.devices[0].onboarding, null);
});

// ---------------------------------------------------------------- TASK_198 ---
// Wrapper scope (env EXE build or sw_wrapper cookie) suppresses the quarantine
// display at ANY tier — the wrapper sells the one public agent, so the
// hide/stay-awake strip is meaningless during the FREE period too.

test("TASK_198: wrapper scope + FREE tier-1 → suppressed (the owner's bug)", async () => {
  resetWorld(1, null);
  wrapperScoped = true;
  assert.equal((await get()).body.devices[0].onboarding, null);
});

test("TASK_198: wrapper scope + tier 0 → suppressed", async () => {
  resetWorld(0, null);
  wrapperScoped = true;
  assert.equal((await get()).body.devices[0].onboarding, null);
});

test("TASK_198: wrapper scope + expired tier-3 term → still suppressed (scope wins)", async () => {
  resetWorld(3, new Date(Date.now() - MIN));
  wrapperScoped = true;
  assert.equal((await get()).body.devices[0].onboarding, null);
});

test("TASK_198: NO wrapper scope (web) + free tier-1 → display KEPT (unchanged)", async () => {
  // The web path must be byte-identical to TASK_191: wrapperScoped resets to
  // false in resetWorld, so this pins the non-wrapper half of the OR.
  resetWorld(1, null);
  assert.ok((await get()).body.devices[0].onboarding);
});

