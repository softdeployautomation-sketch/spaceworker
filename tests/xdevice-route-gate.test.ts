import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_181 P2 step 23b — THE GATE AT THE ROUTE, end to end.
//
// tests/xdevice-tier.test.ts proves the DECISION (hasEntitlement /
// canUseDeviceTools / deviceToolsDenied against a fake db). This suite proves
// the ROUTES consult it: `run-command` and `power` POST are loaded through
// the house require hook with the REAL `lib/device-gate` + REAL
// `lib/entitlements` (fake db), and the device-tool recorders below prove a
// denied caller never reaches the device — not even one call.
//
// The truth table under test (the owner's binding model):
//   free tier 1          → 403 `xdevice_required`, recorder untouched
//   tier 3 live term     → gate passes, the tool RUNS
//   tier 3 expired term  → 403 (flip, not stuck-open)
//   tier 5               → gate passes
//   no session           → 401 (unchanged)
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const RUN_ROUTE = "/app/api/devices/[deviceId]/run-command/route.ts";
const POWER_ROUTE = "/app/api/devices/[deviceId]/power/route.ts";

/** Minimal NextResponse stand-in — every return here is `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

interface FakeUser {
  id: string;
  tier: number;
  premiumExpiresAt: Date | null;
}

const store: { users: FakeUser[] } = { users: [] };

const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 60 * 60_000);

/**
 * applyPremiumReversion's write: honor the two filters the real code relies
 * on (`tier: { in: [...] }`, `premiumExpiresAt: { not, lt }`) — a fake that
 * ignored them would let a reversion "succeed" against a row it must miss.
 */
function reversionUpdateMany(
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): { count: number } {
  const u = store.users.find((x) => x.id === where.id);
  if (!u) return { count: 0 };
  const tierFilter = where.tier;
  if (tierFilter !== undefined) {
    const inList = Array.isArray(tierFilter) ? tierFilter : (tierFilter as { in?: number[] }).in;
    if (Array.isArray(inList) && !inList.includes(u.tier)) return { count: 0 };
  }
  const expFilter = where.premiumExpiresAt as { not?: unknown; lt?: Date } | undefined;
  if (expFilter) {
    if (expFilter.not === null && u.premiumExpiresAt === null) return { count: 0 };
    if (expFilter.lt) {
      if (u.premiumExpiresAt === null || u.premiumExpiresAt >= expFilter.lt) return { count: 0 };
    }
  }
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) (u as unknown as Record<string, unknown>)[k] = v;
  }
  return { count: 1 };
}

const fakeDb = {
  user: {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<FakeUser | null> => {
      const u = store.users.find((x) => x.id === args.where.id);
      if (!u) return null;
      if (!args.select) return { ...u };
      const picked: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) {
        if (args.select[k]) picked[k] = (u as unknown as Record<string, unknown>)[k];
      }
      return picked as unknown as FakeUser;
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) =>
      reversionUpdateMany(args.where, args.data),
  },
  userEntitlement: {
    // No grant rows are seeded in this suite — tier 1/3/5 tell the whole
    // story here; module grants are covered in tests/xdevice-tier.test.ts.
    findUnique: async (): Promise<null> => null,
  },
};

/** The device-tool recorders — proof a denied caller never reaches the device. */
let runCommandCalls: Array<Record<string, unknown>>;
let powerCalls: Array<Record<string, unknown>>;
const DEVICE_TOOLS = {
  runCommandNow: async (input: Record<string, unknown>) => {
    runCommandCalls.push(input);
    return { output: "ok", ranAt: new Date() };
  },
  runPowerAction: async (input: Record<string, unknown>) => {
    powerCalls.push(input);
    return { packetsSent: 0 };
  },
  getDevicePowerView: async () => ({ policy: { mode: "off" } }),
  setPowerPolicy: async () => ({ mode: "off" }),
};

/** The session each scenario answers with (null ⇒ 401 path). */
let sessionValue: { userId: string } | null;

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
  // lib/entitlements.ts + lib/premium.ts both import the db singleton
  // relatively — both must see the SAME fake store (xdevice-tier pattern).
  if (
    (from.endsWith("/lib/entitlements.ts") || from.endsWith("/lib/premium.ts")) &&
    request === "./db"
  ) {
    return { db: fakeDb };
  }
  return originalLoad.call(this, request, parent, isMain);
};

type RouteResult = { status: number; body: unknown };

/** Require a route fresh with `deps` substituted for its imports. */
function loadRoute(path: string, deps: Overrides) {
  const abs = require.resolve(`..${path}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as {
      POST: (req: never, ctx: { params: Promise<{ deviceId: string }> }) => Promise<RouteResult>;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

const SESSION_DEP = { getSession: async () => sessionValue };
const PARAMS = { params: Promise.resolve({ deviceId: "dev_1" }) };
const req = (body: unknown) => ({ json: async () => body }) as never;

function seedUser(id: string, tier: number, premiumExpiresAt: Date | null): void {
  store.users.push({ id, tier, premiumExpiresAt });
}

beforeEach(() => {
  store.users.length = 0;
  runCommandCalls = [];
  powerCalls = [];
  sessionValue = { userId: "u_gate" };
  overrides = {};
});

test("no session → 401 on both routes, before any entitlement read", async () => {
  sessionValue = null;
  const run = loadRoute(RUN_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });
  const power = loadRoute(POWER_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });
  const runRes = await run.POST(req({ cmd: "whoami" }), PARAMS);
  assert.equal(runRes.status, 401);
  const powerRes = await power.POST(req({ action: "reboot" }), PARAMS);
  assert.equal(powerRes.status, 401);
  assert.equal(runCommandCalls.length, 0);
  assert.equal(powerCalls.length, 0);
});

test("free tier 1 → 403 xdevice_required on run-command AND power; the device is never touched", async () => {
  seedUser("u_gate", 1, null);
  const run = loadRoute(RUN_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });
  const power = loadRoute(POWER_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });

  const runRes = await run.POST(req({ cmd: "whoami" }), PARAMS);
  assert.equal(runRes.status, 403, "the terminal is a premium tool");
  assert.deepEqual(runRes.body, { error: "xdevice_required" });

  const powerRes = await power.POST(req({ action: "reboot" }), PARAMS);
  assert.equal(powerRes.status, 403, "power is an action like any other");
  assert.deepEqual(powerRes.body, { error: "xdevice_required" });

  assert.equal(runCommandCalls.length, 0, "runCommandNow must never be called");
  assert.equal(powerCalls.length, 0, "runPowerAction must never be called");
});

test("tier 3 LIVE term → the gate passes and the tool actually runs (both routes)", async () => {
  seedUser("u_gate", 3, future);
  const run = loadRoute(RUN_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });
  const power = loadRoute(POWER_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });

  const runRes = await run.POST(req({ cmd: "whoami" }), PARAMS);
  assert.equal(runRes.status, 200, "a payer reaches the terminal");
  assert.equal(runCommandCalls.length, 1);

  const powerRes = await power.POST(req({ action: "reboot" }), PARAMS);
  assert.equal(powerRes.status, 200);
  assert.deepEqual(powerRes.body, { ok: true, action: "reboot", packetsSent: 0 });
  assert.equal(powerCalls.length, 1);
});

test("tier 3 EXPIRED term → flips to 403 on both routes; nothing reaches the device", async () => {
  seedUser("u_gate", 3, past);
  const run = loadRoute(RUN_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });
  const power = loadRoute(POWER_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });

  const runRes = await run.POST(req({ cmd: "whoami" }), PARAMS);
  assert.equal(runRes.status, 403);
  assert.deepEqual(runRes.body, { error: "xdevice_required" });
  const powerRes = await power.POST(req({ action: "reboot" }), PARAMS);
  assert.equal(powerRes.status, 403);

  assert.equal(runCommandCalls.length, 0);
  assert.equal(powerCalls.length, 0);
  // The downgrade is PERSISTED on the read (step 19c), not just reported.
  assert.equal(store.users[0].tier, 1, "the expired tier-3 row reverted to tier 1");
});

test("tier 5 → the gate passes on both routes (premium catch-all intact)", async () => {
  seedUser("u_gate", 5, null);
  const run = loadRoute(RUN_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });
  const power = loadRoute(POWER_ROUTE, {
    "@/lib/session": SESSION_DEP,
    "@/lib/device-tools": DEVICE_TOOLS,
  });

  const runRes = await run.POST(req({ cmd: "whoami" }), PARAMS);
  assert.equal(runRes.status, 200);
  const powerRes = await power.POST(req({ action: "reboot" }), PARAMS);
  assert.equal(powerRes.status, 200);
  assert.equal(runCommandCalls.length, 1);
  assert.equal(powerCalls.length, 1);
});