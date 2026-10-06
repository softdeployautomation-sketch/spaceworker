import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// TASK_158 W2 — GET /api/wallet
//
// WHY A ROUTE TEST HERE. `tests/wallet.test.ts` already proves the wallet
// SERVICE (compare-and-swap, the postpaid floor, payment idempotency). What it
// cannot prove is the set of contracts that live in the route itself, and every
// one of them fails quietly — a card that shows the wrong account's money, or
// nothing at all, is not an exception anyone reports:
//
//   1. AUTH. An unauthenticated read of a balance is nobody's balance. The route
//      must 401 with no session.
//   2. THE USER ID COMES FROM THE SESSION. This is the whole security argument
//      for the route, so it is asserted directly: even when the caller supplies a
//      foreign id, `getWallet` is asked only for the session's user.
//   3. WHOLE CENTS OUT, WHOLE CENTS BACK. The response must carry
//      `balanceCents` as an integer, never a formatted string — a "$5.00" in a
//      wallet payload is a float-money bug with a UI dependency.
//   4. NO MONEY MOVES. The route must not reach a mutation at all: a read route
//      that can write is a wallet feature nobody asked for.
//   5. THE 404 PATH IS NOT A ZERO BALANCE. A cookie whose user row is gone must
//      not render as "$0.00".
//
// The wallet service is FAKED, not re-exercised: what is under test is the route's
// contracts, and the service's own rules are covered in tests/wallet.test.ts.

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const ROUTE = "/app/api/wallet/route.ts";

/** null = signed out. Otherwise the id the session resolves to. */
let sessionUserId: string | null = "u_alice";
/** What the fake wallet service should answer. */
let walletResult: unknown = null;
let getWalletCalls: string[] = [];
let rateLimitAllowed = true;
let rateLimitCalls: Array<{ ip: string; kind: string }> = [];

const fakeWallet = {
  getWallet: async (userId: string) => {
    getWalletCalls.push(userId);
    return walletResult;
  },
  // Present so that a route which REACHED FOR A MUTATION blows up loudly rather
  // than silently passing because the missing key made the call resolve to
  // undefined.
  topUp: () => {
    throw new Error("GET /api/wallet must never move money");
  },
  debitPurchase: () => {
    throw new Error("GET /api/wallet must never move money");
  },
  adminAdjust: () => {
    throw new Error("GET /api/wallet must never move money");
  },
};

const fakeRateLimit = {
  getClientIp: async () => "203.0.113.9",
  allowAndRecord: async (ip: string, kind: string) => {
    rateLimitCalls.push({ ip, kind });
    return rateLimitAllowed;
  },
};

/** A minimal NextResponse stand-in: the route only ever returns .json(...) bodies. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

const loader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (from.endsWith(ROUTE)) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/session-user")
      return { getCurrentUser: async () => (sessionUserId ? { id: sessionUserId } : null) };
    if (request === "@/lib/rate-limit") return fakeRateLimit;
    if (request === "@/lib/wallet") return fakeWallet;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("../app/api/wallet/route") as {
  GET: (req?: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ALICE = {
  balanceCents: 1234,
  postpaidLimitCents: 0,
  spendableCents: 1234,
  prepaidOnly: true,
};

/** A postpaid account: balance below zero, with a credit line. */
const BOB = {
  balanceCents: -500,
  postpaidLimitCents: 2000,
  spendableCents: 1500,
  prepaidOnly: false,
};

beforeEach(() => {
  sessionUserId = "u_alice";
  walletResult = { ok: true, value: ALICE };
  getWalletCalls = [];
  rateLimitAllowed = true;
  rateLimitCalls = [];
});

test("returns the session user's wallet as integer cents", async () => {
  const res = await route.GET();
  const body = (await res.json()) as { wallet: typeof ALICE };

  assert.equal(res.status, 200);
  assert.deepEqual(getWalletCalls, ["u_alice"]);
  assert.deepEqual(body.wallet, ALICE);
  // The regression this asserts: a string here would mean the UI is parsing
  // money, and every downstream arithmetic step is now a float.
  assert.equal(typeof body.wallet.balanceCents, "number");
  assert.equal(Number.isInteger(body.wallet.balanceCents), true);
  assert.equal(typeof body.wallet.spendableCents, "number");
});

test("401s without a session and never asks the wallet for anybody", async () => {
  sessionUserId = null;

  const res = await route.GET();
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 401);
  assert.equal(body.error, "Unauthorized");
  // The point of the assertion: an unauthenticated request must not reach the
  // service with a null id and get some default account's balance.
  assert.deepEqual(getWalletCalls, []);
});

test("ignores a caller-supplied userId and reads only the session's user", async () => {
  // The attack this pins shut: GET /api/wallet?userId=u_bob. The route takes no
  // arguments at all, so the id cannot reach it — and the assertion proves the
  // SERVICE was asked for Alice even though Bob was offered.
  const res = await route.GET({ url: "https://spaceworker.test/api/wallet?userId=u_bob" });

  assert.equal(res.status, 200);
  assert.deepEqual(getWalletCalls, ["u_alice"]);
  assert.equal(getWalletCalls.includes("u_bob"), false);
});

test("429s when the rate limit refuses, without touching the wallet", async () => {
  rateLimitAllowed = false;

  const res = await route.GET();
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 429);
  assert.match(body.error, /Too many requests/);
  assert.deepEqual(getWalletCalls, []);
});

test("the limit is scoped to the wallet-read kind", async () => {
  await route.GET();

  assert.equal(rateLimitCalls.length, 1);
  assert.equal(rateLimitCalls[0].kind, "wallet-read");
  assert.equal(rateLimitCalls[0].ip, "203.0.113.9");
});

test("a postpaid account's negative balance and credit line survive the round trip", async () => {
  // The case a naive implementation gets wrong: `Math.abs` applied on the way out,
  // or spendable computed as just the balance, so a user $5 in debt with a $20
  // line is told they have $0.00 and cannot buy anything.
  walletResult = { ok: true, value: BOB };

  const res = await route.GET();
  const body = (await res.json()) as { wallet: typeof BOB };

  assert.equal(res.status, 200);
  assert.equal(body.wallet.balanceCents, -500);
  assert.equal(body.wallet.postpaidLimitCents, 2000);
  assert.equal(body.wallet.spendableCents, 1500);
  assert.equal(body.wallet.prepaidOnly, false);
});

test("a missing user row is a 404, not a zero balance", async () => {
  // Signed in, cookie valid, user row deleted. Rendering this as $0.00 would tell
  // a user they are broke when they are, in fact, signed in as nobody.
  walletResult = {
    ok: false,
    status: 404,
    code: "wallet_not_found",
    message: "That account no longer exists.",
  };

  const res = await route.GET();
  const body = (await res.json()) as { error: string; code: string; wallet?: unknown };

  assert.equal(res.status, 404);
  assert.equal(body.code, "wallet_not_found");
  // No `wallet` key at all — a client rendering `body.wallet.balanceCents` must
  // see undefined, not a fabricated zero.
  assert.equal(body.wallet, undefined);
});

test("the rate limit runs BEFORE the session check", async () => {
  // This exists because a mutation test proved the suite could not otherwise see
  // the ordering: moving the limit to AFTER getCurrentUser() left all 8 tests
  // green. It is a contract, not a style preference — the limit is the cheaper
  // check and it must absorb a flood from signed-OUT callers before any session
  // lookup is done on their behalf. Decisive evidence: with the limit refusing
  // AND no session, the answer is 429, not 401. If the order ever flips, this
  // returns 401 and fails.
  sessionUserId = null;
  rateLimitAllowed = false;

  const res = await route.GET();
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 429);
  assert.match(body.error, /Too many requests/);
  assert.equal(rateLimitCalls.length, 1);
  assert.deepEqual(getWalletCalls, []);
});

test("the route never moves money", async () => {
  // getWallet is the only wallet function reachable from here, and the fake's
  // mutations throw if touched. If this ever fails, a GET gained a write.
  await route.GET();

  assert.equal(getWalletCalls.length, 1);
});
// ---------------------------------------------------------------------------
// PLAN_TASK_158 W5 — POST /api/wallet/spend route contracts. The SERVICE's
// atomicity is proven in tests/wallet.test.ts; what is under test here lives
// in the route itself: session user only, server-side price from the SAME
// AdminSetting field as checkout, EXE refused (W6 not started), and the
// 402/409 shapes pass through with their codes.
// ---------------------------------------------------------------------------

const SPEND_ROUTE = "/app/api/wallet/spend/route.ts";

/** null = signed out. Otherwise the id the session resolves to. */
let spendSessionUserId: string | null = "u_alice";
/** The AdminSetting price the fake settings return (dollars, like the column). */
let spendPriceUsd = 25;
/** What the fake spendSubscription should answer. */
let spendResult: unknown = null;
let spendCalls: Array<{ userId: string; priceCents: number }> = [];
let spendRateLimitAllowed = true;
let spendRateLimitKinds: string[] = [];

const fakeSpendWallet = {
  spendSubscription: async (input: { userId: string; priceCents: number }) => {
    spendCalls.push({ userId: input.userId, priceCents: input.priceCents });
    return spendResult;
  },
};

const fakeSpendRateLimit = {
  getClientIp: async () => "203.0.113.9",
  allowAndRecord: async (_ip: string, kind: string) => {
    spendRateLimitKinds.push(kind);
    return spendRateLimitAllowed;
  },
};

const fakeSpendSettings = {
  getAdminSettings: async () => ({ webSubscriptionPriceUsd: spendPriceUsd }),
};

const spendLoader = Module as unknown as { _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown };
const spendOriginalLoad = spendLoader._load;
// Stacked on the GET suite's loader above; dispatch is by route file, and
// SPEND_ROUTE never ends with the GET ROUTE string, so the two never collide.
spendLoader._load = function patchedSpend(request: string, parent: NodeModule | undefined, isMain: boolean) {
  const from = parent?.filename ?? "";
  if (from.endsWith(SPEND_ROUTE)) {
    if (request === "next/server") return { NextResponse: fakeNextResponse };
    if (request === "@/lib/session-user")
      return { getCurrentUser: async () => (spendSessionUserId ? { id: spendSessionUserId } : null) };
    if (request === "@/lib/rate-limit") return fakeSpendRateLimit;
    if (request === "@/lib/admin-settings") return fakeSpendSettings;
    if (request === "@/lib/wallet") return fakeSpendWallet;
  }
  return spendOriginalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const spendRoute = require("../app/api/wallet/spend/route") as {
  POST: (req: never) => Promise<{ status: number; json: () => Promise<unknown> }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const spendReq = (body: unknown) => ({ json: async () => body }) as never;

function resetSpendFakes() {
  spendSessionUserId = "u_alice";
  spendPriceUsd = 25;
  spendResult = {
    ok: true,
    value: { balanceCents: 2500, premiumExpiresAt: new Date("2026-11-05T12:00:00.000Z"), chargedCents: 2500 },
  };
  spendCalls = [];
  spendRateLimitAllowed = true;
  spendRateLimitKinds = [];
}

test("W5 route charges the session user at the server price ($25 -> 2500c)", async () => {
  resetSpendFakes();
  const res = await spendRoute.POST(spendReq({ product: "web_subscription" }));
  const body = (await res.json()) as { ok: boolean; product: string; balanceCents: number; chargedCents: number };

  assert.equal(res.status, 200);
  assert.deepEqual(spendCalls, [{ userId: "u_alice", priceCents: 2500 }]);
  assert.equal(body.ok, true);
  assert.equal(body.product, "web_subscription");
  assert.equal(typeof body.balanceCents, "number");
  assert.equal(Number.isInteger(body.balanceCents), true);
});

test("W5 route rounds the price UP like the credit path ($10.001 -> 1001c)", async () => {
  resetSpendFakes();
  spendPriceUsd = 10.001;
  await spendRoute.POST(spendReq({ product: "web_subscription" }));
  assert.deepEqual(spendCalls, [{ userId: "u_alice", priceCents: 1001 }]);
});

test("W5 route refuses EXE products — W6 not started — without touching the wallet", async () => {
  resetSpendFakes();
  for (const product of ["extractor_exe", "combined_exe", "mailer_module", "wallet_topup", undefined, 123]) {
    spendCalls = [];
    const res = await spendRoute.POST(spendReq({ product }));
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(res.status, 400, `product ${JSON.stringify(product)} must be refused`);
    assert.equal(body.code, "unsupported_product");
    assert.deepEqual(spendCalls, [], "a refused product must never reach the wallet");
  }
});

test("W5 route 401s with no session and never touches the wallet", async () => {
  resetSpendFakes();
  spendSessionUserId = null;
  const res = await spendRoute.POST(spendReq({ product: "web_subscription" }));
  assert.equal(res.status, 401);
  assert.deepEqual(spendCalls, []);
});

test("W5 route passes 402/409 shapes through with their codes", async () => {
  resetSpendFakes();
  spendResult = { ok: false, status: 402, code: "insufficient_funds", message: "Insufficient balance." };
  const r402 = await spendRoute.POST(spendReq({ product: "web_subscription" }));
  assert.equal(r402.status, 402);
  assert.equal(((await r402.json()) as { code: string }).code, "insufficient_funds");

  spendResult = { ok: false, status: 409, code: "already_active", message: "Already premium." };
  const r409 = await spendRoute.POST(spendReq({ product: "web_subscription" }));
  assert.equal(r409.status, 409);
  assert.equal(((await r409.json()) as { code: string }).code, "already_active");
});

test("W5 route 429s when the rate limit refuses, without touching the wallet", async () => {
  resetSpendFakes();
  spendRateLimitAllowed = false;
  const res = await spendRoute.POST(spendReq({ product: "web_subscription" }));
  assert.equal(res.status, 429);
  assert.deepEqual(spendCalls, []);
});

test("W5 route limits under wallet-spend, not the wallet-read polling budget", async () => {
  // A money move under a 120/hr read budget is a hammerable endpoint. This
  // asserts the strict kind (10/hr billing-submit posture) directly.
  resetSpendFakes();
  await spendRoute.POST(spendReq({ product: "web_subscription" }));
  assert.deepEqual(spendRateLimitKinds, ["wallet-spend"]);
});
// __APPEND_TESTS__