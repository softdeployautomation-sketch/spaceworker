// TASK_181 P3 (step 31) — the XDevice wrapper PREMIUM payment contracts.
//
// Three surfaces, one rule each:
//   1. CATALOG — `xdevice` is a real product priced by AdminSetting.xdevicePriceUsd
//      (admin-adjustable; a hardcoded 500 anywhere in a price path is a bug).
//   2. GRANT — grantXDeviceTerm (the crypto-checkout consequence) grants exactly
//      ONE tier-3 term per call, STACKS an early renewal, and HOLDS THE HARD
//      RULE: an active tier-5 account is never lowered (owner: a wrapper purchase
//      must not downgrade Premium).
//   3. ROUTE — POST /api/wallet/spend computes priceCents SERVER-side from
//      xdevicePriceUsd (a client-supplied amount is never read), routes xdevice
//      to spendXDevice and web_subscription to spendSubscription, and refuses
//      anything else before money is touched. House require-hook pattern
//      (tests/wallet-route.test.ts).
//
// Run: npx tsx --test tests/xdevice-payment.test.ts

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import { ALL_PRODUCTS, getProduct } from "../lib/products";

// ---------------------------------------------------------------------------
// grantXDeviceTerm + handleApprovedPayment — real lib, faked db.
// ---------------------------------------------------------------------------

interface FakeUserRow {
  id: string;
  tier: number;
  premiumExpiresAt: Date | null;
}

const users = new Map<string, FakeUserRow>();
/** Every user write, in order — so "refused = no write" can be asserted. */
let userWrites: Array<{ id: string; data: Record<string, unknown> }> = [];

const payments = new Map<string, Record<string, unknown>>();

const fakeDb = {
  user: {
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const u = users.get(where.id);
      if (!u) throw new Error(`fake db: no user ${where.id}`);
      return { ...u };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      userWrites.push({ id: where.id, data });
      const u = users.get(where.id);
      if (!u) throw new Error(`fake db: no user ${where.id}`);
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) (u as unknown as Record<string, unknown>)[k] = v;
      }
      return { ...u };
    },
  },
  payment: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const p = payments.get(where.id);
      return p ? { ...p } : null;
    },
  },
  // Present so any accidental entitlement read fails loudly instead of
  // returning undefined-shaped data that silently passes an assertion.
  userEntitlement: {
    findMany: async () => {
      throw new Error("xdevice payment must never read entitlement rows");
    },
  },
};

const fakeEmail = {
  sendEmail: async () => {
    throw new Error("xdevice must never send an email");
  },
  exeLicenseIssuedEmailHtml: () => "",
};
const fakeEnv = { env: {} };

const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  // ANY lib module (exe-license pulls server-only too, via license-service's
  // import chain) — never node_modules, never this test file.
  const fromLib = from.endsWith(".ts") && !from.includes("node_modules") && from.includes("/lib/");
  if (fromLib) {
    if (request === "server-only") return {};
    if (request === "./db") return { db: fakeDb };
    if (request === "./email") return fakeEmail;
    if (request === "./env") return fakeEnv;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const premium = require("../lib/premium") as typeof import("../lib/premium");
const licenseService = require("../lib/license-service") as typeof import("../lib/license-service");
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  users.clear();
  payments.clear();
  userWrites = [];
});

function seed(id: string, tier: number, premiumExpiresAt: Date | null): void {
  users.set(id, { id, tier, premiumExpiresAt });
}

test("catalog: xdevice is purchasable and priced by the admin field", () => {
  const x = getProduct("xdevice");
  assert.ok(x && ALL_PRODUCTS.includes(x));
  assert.equal(x!.priceField, "xdevicePriceUsd");
});

test("grantXDeviceTerm: free account → tier 3 with one ~30-day term", async () => {
  seed("u1", 1, null);
  const before = Date.now();
  const expiry = await premium.grantXDeviceTerm("u1");

  assert.ok(expiry instanceof Date);
  const days = (expiry!.getTime() - before) / DAY;
  assert.ok(days > 29 && days < 31, `one term = ~30 days, got ${days}`);
  assert.equal(users.get("u1")!.tier, 3);
});

test("grantXDeviceTerm: an ACTIVE tier-3 term stacks from its current expiry (never resets)", async () => {
  const first = new Date(Date.now() + 10 * DAY);
  seed("u1", 3, first);
  const expiry = await premium.grantXDeviceTerm("u1");

  assert.ok(expiry);
  const days = (expiry!.getTime() - first.getTime()) / DAY;
  assert.ok(days > 29 && days < 31, `stacking must ADD ~30 days to the live expiry, got ${days}`);
});

test("grantXDeviceTerm: an ACTIVE tier-5 is never lowered — returns null, writes NOTHING", async () => {
  const expiry = new Date(Date.now() + 10 * DAY);
  seed("u1", 5, expiry);
  const res = await premium.grantXDeviceTerm("u1");

  assert.equal(res, null, "the HARD RULE must fire");
  assert.equal(users.get("u1")!.tier, 5, "tier 5 must be untouched");
  assert.equal(users.get("u1")!.premiumExpiresAt!.getTime(), expiry.getTime());
  assert.equal(userWrites.length, 0, "no write at all");
});

test("grantXDeviceTerm: grandfathered tier-5 (NULL expiry) is never lowered either", async () => {
  seed("u1", 5, null);
  const res = await premium.grantXDeviceTerm("u1");

  assert.equal(res, null);
  assert.equal(users.get("u1")!.tier, 5);
  assert.equal(users.get("u1")!.premiumExpiresAt, null);
  assert.equal(userWrites.length, 0);
});

test("grantXDeviceTerm: an EXPIRED tier-3 restarts its term from now", async () => {
  seed("u1", 3, new Date(Date.now() - DAY));
  const before = Date.now();
  const expiry = await premium.grantXDeviceTerm("u1");

  assert.ok(expiry && expiry.getTime() >= before, "never stack onto the past");
  assert.equal(users.get("u1")!.tier, 3);
});

test("handleApprovedPayment(xdevice): one approved payment grants exactly ONE tier-3 term", async () => {
  seed("u1", 1, null);
  payments.set("p1", { id: "p1", status: "approved", product: "xdevice", userId: "u1" });
  const before = Date.now();

  await licenseService.handleApprovedPayment("p1");

  const u = users.get("u1")!;
  assert.equal(u.tier, 3);
  const days = (u.premiumExpiresAt!.getTime() - before) / DAY;
  assert.ok(days > 29 && days < 31, `exactly one ~30-day term, got ${days}`);
});

test("handleApprovedPayment(xdevice): NEVER downgrades an active tier-5 account", async () => {
  const expiry = new Date(Date.now() + 10 * DAY);
  seed("u1", 5, expiry);
  payments.set("p1", { id: "p1", status: "approved", product: "xdevice", userId: "u1" });

  await licenseService.handleApprovedPayment("p1");

  const u = users.get("u1")!;
  assert.equal(u.tier, 5, "a wrapper purchase must never lower Premium");
  assert.equal(u.premiumExpiresAt!.getTime(), expiry.getTime());
  assert.equal(userWrites.length, 0);
});

// ---------------------------------------------------------------------------
// POST /api/wallet/spend — the price source and product routing.
// ---------------------------------------------------------------------------

const SPEND_ROUTE = "/app/api/wallet/spend/route.ts";

let sessionUserId: string | null = "u1";
let settings: Record<string, number> = {};
let spendXCalls: Array<{ userId: string; priceCents: number; idempotencyKey?: string }> = [];
let spendWebCalls: Array<{ userId: string; priceCents: number; idempotencyKey?: string }> = [];
let spendXResult: unknown = { ok: true, value: { balanceCents: 0, premiumExpiresAt: new Date(), chargedCents: 50000 } };
let spendWebResult: unknown = { ok: true, value: { balanceCents: 0, premiumExpiresAt: new Date(), chargedCents: 2500 } };

const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

const spendOriginalLoad = loader._load;
loader._load = function patchedSpend(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (from.endsWith(SPEND_ROUTE)) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/session-user")
      return { getCurrentUser: async () => (sessionUserId ? { id: sessionUserId } : null) };
    if (request === "@/lib/rate-limit")
      return { getClientIp: async () => "203.0.113.9", allowAndRecord: async () => true };
    if (request === "@/lib/admin-settings") return { getAdminSettings: async () => settings };
    if (request === "@/lib/wallet")
      return {
        spendXDevice: async (input: { userId: string; priceCents: number; idempotencyKey?: string }) => {
          spendXCalls.push(input);
          return spendXResult;
        },
        spendSubscription: async (input: { userId: string; priceCents: number; idempotencyKey?: string }) => {
          spendWebCalls.push(input);
          return spendWebResult;
        },
      };
  }
  return spendOriginalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const spendRoute = require("../app/api/wallet/spend/route") as {
  POST: (req: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function req(body: unknown): unknown {
  return { json: async () => body };
}

beforeEach(() => {
  sessionUserId = "u1";
  settings = { xdevicePriceUsd: 500, webSubscriptionPriceUsd: 25 };
  spendXCalls = [];
  spendWebCalls = [];
  spendXResult = { ok: true, value: { balanceCents: 0, premiumExpiresAt: new Date(), chargedCents: 50000 } };
  spendWebResult = { ok: true, value: { balanceCents: 0, premiumExpiresAt: new Date(), chargedCents: 2500 } };
});

test("spend route: xdevice charges ADMIN price × 100 (no amount is ever read from the body)", async () => {
  const res = await spendRoute.POST(req({ product: "xdevice", amountUsd: 1, priceCents: 5 }));
  assert.equal(res.status, 200);
  assert.equal(spendXCalls.length, 1);
  assert.equal(spendXCalls[0].priceCents, 50000, "500 admin dollars → 50000 cents, body ignored");
  assert.equal(spendWebCalls.length, 0);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.product, "xdevice");
});

test("spend route: the price FOLLOWS the admin field — no hardcoded 500 anywhere", async () => {
  settings = { xdevicePriceUsd: 499.99, webSubscriptionPriceUsd: 25 };
  const res = await spendRoute.POST(req({ product: "xdevice" }));
  assert.equal(res.status, 200);
  assert.equal(spendXCalls[0].priceCents, 49999, "ceil(admin dollars × 100), exactly like W5");
});

test("spend route: web_subscription still routes to spendSubscription with its own price", async () => {
  const res = await spendRoute.POST(req({ product: "web_subscription" }));
  assert.equal(res.status, 200);
  assert.equal(spendWebCalls.length, 1);
  assert.equal(spendWebCalls[0].priceCents, 2500);
  assert.equal(spendXCalls.length, 0);
});

test("spend route: an unknown product = 400 unsupported_product BEFORE any price or wallet call", async () => {
  const res = await spendRoute.POST(req({ product: "extractor_exe" }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "unsupported_product");
  assert.equal(spendXCalls.length, 0);
  assert.equal(spendWebCalls.length, 0);
});

test("spend route: service failures pass through with their status (402/409, …)", async () => {
  spendXResult = { ok: false, status: 409, code: "already_active", message: "no charge" };
  const res = await spendRoute.POST(req({ product: "xdevice" }));
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "already_active");
});

test("spend route: no session = 401, wallet never reached", async () => {
  sessionUserId = null;
  const res = await spendRoute.POST(req({ product: "xdevice" }));
  assert.equal(res.status, 401);
  assert.equal(spendXCalls.length, 0);
});