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
// __APPEND_TESTS__