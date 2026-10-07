import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_181 P2 — tier 3 (XDevice) + the device-action gate.
//
// THE FAILURE THIS SUITE EXISTS TO PREVENT (two directions, both live-money):
//
//   1. SCOPE CREEP — tier 3 is the wrapper's "Subscribe to Premium" (devices
//      only). If hasEntitlement ever answers tier 3 with the tier-5 catch-all,
//      a $500 device subscription silently lights up mailer/extractor/hosting/
//      cyberlab. Every test below asserts NON-device keys stay DENIED for tier 3.
//   2. THE SPLIT-BRAIN THE STEPS FILE CALLS OUT (19b) — the console paints its
//      lock state from listEffectiveEntitlements while the routes gate on
//      hasEntitlement. If those two disagree, a paying tier-3 user stares at an
//      upgrade card over tools the server would happily run (or, worse, the
//      reverse). The key-set tests and the decision tests must tell ONE story.
//
// Plus the timing rules: tier 3 shares User.premiumExpiresAt — live term = on,
// passed term = lazily reverted to tier 1 (PERSISTED, not just reported) and
// off; NULL term = grandfathered, same as tier 5.
//
// The real lib/entitlements.ts + lib/premium.ts + lib/session-user.ts load
// against a fake db through the house require hook (wallet.test.ts pattern);
// only `server-only`, `./db` and `./auth` are swapped.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
(process.env as Record<string, string>).DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

interface FakeUser {
  id: string;
  tier: number;
  premiumExpiresAt: Date | null;
}

interface FakeGrant {
  id: string;
  userId: string;
  key: string;
  source: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  grantedAt: Date;
}

const store: { users: FakeUser[]; grants: FakeGrant[] } = { users: [], grants: [] };
/** Every write, in order — a test can prove NOTHING was written on a no-op. */
let writes: Array<{ op: string; data: Record<string, unknown> }> = [];

// Fixed clock ONLY for grantedAt stamps. `past`/`future` must be relative to
// real now — hasEntitlement/isXdeviceLive compare against Date.now() against
// REAL time, so a hardcoded 12:00 "future" goes stale the moment the wall
// clock passes it (that bug made 6 tests fail at 14:26 while looking correct).
const clock = new Date();
const past = new Date(Date.now() - 60_000);
const future = new Date(Date.now() + 60 * 60_000);

let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

/**
 * user.updateMany with the two filters the lazy reversion actually uses:
 * `tier: { in: [...] }` and `premiumExpiresAt: { not: null, lt }`. A fake that
 * ignored them would let a reversion "succeed" against a row it must miss —
 * the count===0 miss is exactly what the real code relies on.
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
  writes.push({ op: "user.updateMany", data });
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
    findUnique: async (args: {
      where: { userId_key: { userId: string; key: string } };
      select?: Record<string, boolean>;
    }): Promise<FakeGrant | null> => {
      const { userId, key } = args.where.userId_key;
      const g = store.grants.find((x) => x.userId === userId && x.key === key);
      if (!g) return null;
      if (!args.select) return { ...g };
      const picked: Record<string, unknown> = {};
      for (const k of Object.keys(args.select)) {
        if (args.select[k]) picked[k] = (g as unknown as Record<string, unknown>)[k];
      }
      return picked as unknown as FakeGrant;
    },
    findMany: async (args: { where: { userId: string } }): Promise<FakeGrant[]> =>
      store.grants.filter((g) => g.userId === args.where.userId).map((g) => ({ ...g })),
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const g of store.grants) {
        if (args.where.id !== undefined && g.id !== args.where.id) continue;
        if ("revokedAt" in args.where && (args.where as { revokedAt: unknown }).revokedAt === null && g.revokedAt !== null) continue;
        writes.push({ op: "userEntitlement.updateMany", data: args.data });
        for (const [k, v] of Object.entries(args.data)) {
          if (v !== undefined) (g as unknown as Record<string, unknown>)[k] = v;
        }
        count++;
      }
      return { count };
    },
  },
};

/** Session stub control for lib/session-user.ts tests. */
let sessionHolder: { sub: string } | null = null;

/** Minimal NextResponse stand-in — `deviceToolsDenied` only ever returns `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (request === "server-only") return {};
  // TASK_181 step 23a — lib/device-gate.ts returns NextResponse.json(...) for
  // the 403; the stand-in keeps the shape ({status, body, json()}) assertable.
  if (request === "next/server") return { NextResponse: fakeNextResponse };
  // lib/entitlements.ts, lib/premium.ts and lib/session-user.ts all import the
  // db singleton relatively — all three must see the SAME fake store.
  if (
    (from.endsWith("/lib/entitlements.ts") ||
      from.endsWith("/lib/premium.ts") ||
      from.endsWith("/lib/session-user.ts")) &&
    request === "./db"
  ) {
    return { db: fakeDb };
  }
  if (from.endsWith("/lib/session-user.ts") && request === "./auth") {
    return { getSession: async () => sessionHolder };
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const ent = require("../lib/entitlements") as typeof import("../lib/entitlements");
const sessionUser = require("../lib/session-user") as typeof import("../lib/session-user");
// TASK_181 step 23a — the REAL route-facing gate (lib/device-gate.ts), same
// fake db through the same hook; only `next/server` above is swapped.
const gate = require("../lib/device-gate") as typeof import("../lib/device-gate");
/* eslint-enable @typescript-eslint/no-require-imports */

const { hasEntitlement, listEffectiveEntitlements, canUseDeviceTools } = ent;
const { deviceToolsDenied } = gate;

function seedUser(id: string, tier: number, premiumExpiresAt: Date | null): FakeUser {
  const u: FakeUser = { id, tier, premiumExpiresAt };
  store.users.push(u);
  return u;
}

function seedGrant(userId: string, key: string, extra: Partial<FakeGrant> = {}): FakeGrant {
  const g: FakeGrant = {
    id: nextId("ue"),
    userId,
    key,
    source: "module",
    expiresAt: null,
    revokedAt: null,
    grantedAt: clock,
    ...extra,
  };
  store.grants.push(g);
  return g;
}

// ---------------------------------------------------------------------------
// 19a — hasEntitlement: scope of tier 3.
// ---------------------------------------------------------------------------

test("tier 1 (free) holds nothing — devices denied, no catch-all", async () => {
  seedUser("u_free", 1, null);
  assert.deepEqual(await hasEntitlement("u_free", "devices"), { allowed: false, reason: "none" });
  assert.deepEqual(await hasEntitlement("u_free", "mailer"), { allowed: false, reason: "none" });
});

test("tier 3 LIVE term: devices allowed as reason 'xdevice'; every OTHER key denied", async () => {
  seedUser("u_x", 3, future);
  assert.deepEqual(await hasEntitlement("u_x", "devices"), { allowed: true, reason: "xdevice" });
  // The whole point of the tier: no tier-5 catch-all, in any direction.
  for (const key of ["mailer", "extractor", "assistant", "cyberlab", "hosting"] as const) {
    assert.deepEqual(
      await hasEntitlement("u_x", key),
      { allowed: false, reason: "none" },
      `tier 3 must NOT light up '${key}'`,
    );
  }
});

test("tier 3 with NULL expiry is grandfathered on (same rule as tier 5)", async () => {
  seedUser("u_x_null", 3, null);
  assert.deepEqual(await hasEntitlement("u_x_null", "devices"), { allowed: true, reason: "xdevice" });
});

test("tier 3 EXPIRED term: devices denied AND the downgrade to tier 1 is PERSISTED", async () => {
  const u = seedUser("u_x_dead", 3, past);
  assert.deepEqual(await hasEntitlement("u_x_dead", "devices"), { allowed: false, reason: "none" });
  assert.equal(u.tier, 1, "lazy reversion must flip tier 3 → 1 in the row itself");
  assert.equal(writes.filter((w) => w.op === "user.updateMany").length, 1, "exactly one persisted downgrade");
  assert.deepEqual(await hasEntitlement("u_x_dead", "devices"), { allowed: false, reason: "none" });
  assert.equal(writes.filter((w) => w.op === "user.updateMany").length, 1, "reversion is once, not per-read");
});

test("tier 3 expired + a separately purchased devices grant: still allowed via the grant row", async () => {
  seedUser("u_x_grant", 3, past);
  seedGrant("u_x_grant", "devices");
  assert.deepEqual(await hasEntitlement("u_x_grant", "devices"), { allowed: true, reason: "grant" });
});

test("tier 5 keeps the full catch-all, premium reason", async () => {
  seedUser("u_p", 5, future);
  assert.deepEqual(await hasEntitlement("u_p", "mailer"), { allowed: true, reason: "premium" });
  assert.deepEqual(await hasEntitlement("u_p", "devices"), { allowed: true, reason: "premium" });
});

test("module grant rows work for free users (Assistant & Devices buyers must not regress)", async () => {
  seedUser("u_mod", 1, null);
  seedGrant("u_mod", "devices");
  assert.deepEqual(await hasEntitlement("u_mod", "devices"), { allowed: true, reason: "grant" });
  store.grants[0].revokedAt = past;
  assert.deepEqual(await hasEntitlement("u_mod", "devices"), { allowed: false, reason: "expired" });
});

test("expired grant term is lazily stamped revoked and denied (Task 55 behavior intact)", async () => {
  seedUser("u_gone", 1, null);
  seedGrant("u_gone", "mailer", { expiresAt: past });
  assert.deepEqual(await hasEntitlement("u_gone", "mailer"), { allowed: false, reason: "expired" });
  assert.equal(store.grants[0].revokedAt instanceof Date, true, "stamped once");
});

beforeEach(() => {
  store.users = [];
  store.grants = [];
  writes = [];
  sessionHolder = null;
  seq = 0;
});


// ---------------------------------------------------------------------------
// 19b — listEffectiveEntitlements must agree with hasEntitlement (split-brain).
// ---------------------------------------------------------------------------

test("listEffectiveEntitlements: tier 3 → keys ['devices'] AND premium false", async () => {
  seedUser("u_x", 3, future);
  const out = await listEffectiveEntitlements("u_x");
  assert.deepEqual(out.keys, ["devices"]);
  assert.equal(out.premium, false, "tier 3 is NOT tier 5 premium");
});

test("listEffectiveEntitlements: tier 3 expired → no devices key (agrees with the gate)", async () => {
  seedUser("u_x_dead", 3, past);
  const out = await listEffectiveEntitlements("u_x_dead");
  assert.ok(!out.keys.includes("devices"), "an expired term must not surface the key");
  assert.equal(store.users[0].tier, 1, "and the row reverted");
});

test("listEffectiveEntitlements: tier 5 → all keys, premium true (unchanged)", async () => {
  seedUser("u_p", 5, null);
  const out = await listEffectiveEntitlements("u_p");
  assert.equal(out.premium, true);
  assert.deepEqual(out.keys.length, ent.ENTITLEMENT_KEYS.length);
});

test("listEffectiveEntitlements: tier 3 unions its devices key with live grants", async () => {
  seedUser("u_x_both", 3, future);
  seedGrant("u_x_both", "hosting");
  const out = await listEffectiveEntitlements("u_x_both");
  assert.ok(out.keys.includes("devices"));
  assert.ok(out.keys.includes("hosting"));
  assert.equal(out.premium, false);
});

// ---------------------------------------------------------------------------
// Step 20 — canUseDeviceTools: THE route gate, one decision.
// ---------------------------------------------------------------------------

test("canUseDeviceTools truth table: free ✗ · tier-3-live ✓ · tier-3-dead ✗ · tier-5 ✓ · grant ✓", async () => {
  seedUser("t_free", 1, null);
  seedUser("t_live", 3, future);
  seedUser("t_dead", 3, past);
  seedUser("t_prem", 5, future);
  seedUser("t_grant", 1, null);
  seedGrant("t_grant", "devices");

  assert.equal(await canUseDeviceTools("t_free"), false);
  assert.equal(await canUseDeviceTools("t_live"), true);
  assert.equal(await canUseDeviceTools("t_dead"), false);
  assert.equal(await canUseDeviceTools("t_prem"), true);
  assert.equal(await canUseDeviceTools("t_grant"), true);
  assert.equal(await canUseDeviceTools("t_missing"), false, "unknown user denies");
});

// ---------------------------------------------------------------------------
// 19c — getCurrentUser: the stale-row fix on tier-3 reversion.
// ---------------------------------------------------------------------------

test("getCurrentUser: expired tier 3 re-reads as tier 1 (never returns the stale row)", async () => {
  seedUser("u_sess", 3, past);
  sessionHolder = { sub: "u_sess" };
  const u = await sessionUser.getCurrentUser();
  assert.ok(u);
  assert.equal(u.tier, 1, "the returned user must reflect the persisted downgrade");
  assert.equal(store.users[0].tier, 1);
});

test("getCurrentUser: LIVE tier 3 returns tier 3 untouched", async () => {
  seedUser("u_sess_live", 3, future);
  sessionHolder = { sub: "u_sess_live" };
  const u = await sessionUser.getCurrentUser();
  assert.ok(u);
  assert.equal(u.tier, 3);
  assert.equal(writes.length, 0, "no reversion on a live term");
});

test("getCurrentUser: no session → null (unchanged)", async () => {
  sessionHolder = null;
  assert.equal(await sessionUser.getCurrentUser(), null);
});

// ---------------------------------------------------------------------------
// 22/23a — deviceToolsDenied: THE route-facing 403, same truth table as
// canUseDeviceTools but asserting the exact status + body routes return.
// ---------------------------------------------------------------------------

test("deviceToolsDenied: free tier 1 → 403 with the exact body routes return", async () => {
  seedUser("u_gate_free", 1, null);
  const res = await deviceToolsDenied("u_gate_free");
  assert.ok(res, "free must be denied");
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "xdevice_required" });
});

test("deviceToolsDenied: tier 3 LIVE → null (passes) · term then EXPIRED → 403", async () => {
  seedUser("u_gate_t3", 3, future);
  assert.equal(await deviceToolsDenied("u_gate_t3"), null, "live XDevice term passes");
  const u = store.users.find((x) => x.id === "u_gate_t3");
  assert.ok(u);
  u.premiumExpiresAt = past;
  const res = await deviceToolsDenied("u_gate_t3");
  assert.ok(res, "an expired XDevice term must deny");
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "xdevice_required" });
});

test("deviceToolsDenied: tier 5 → null · devices grant → null · unknown user → 403", async () => {
  seedUser("u_gate_t5", 5, null);
  assert.equal(await deviceToolsDenied("u_gate_t5"), null, "premium passes");
  seedUser("u_gate_grant", 1, null);
  seedGrant("u_gate_grant", "devices");
  assert.equal(await deviceToolsDenied("u_gate_grant"), null, "module buyers keep working");
  const res = await deviceToolsDenied("u_gate_ghost");
  assert.ok(res, "an unknown user is denied");
  assert.equal(res.status, 403);
});

