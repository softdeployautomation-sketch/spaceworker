import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_167 W4 — the crypto wallet top-up.
//
// The failure this suite exists to prevent, in one sentence: a customer clicks
// "Add $10 to my wallet", and somewhere along the way money appears in a wallet
// that was never actually paid for. Every test below guards one link in that
// chain, and they are deliberately not all about the happy path:
//
//   1. THE FLOOR IS THE CONFIGURED ONE. Not a hardcoded $5 that silently
//      disagrees with the number the admin typed into the settings tab.
//   2. OPENING AN ORDER IS NOT PAYMENT — it creates a `pending` row and must not
//      touch a wallet or the licence service AT ALL.
//   3. SUBMITTING A HASH IS NOT PAYMENT EITHER. The customer hands over a
//      confirmed transaction and the row stays `pending`. The whole feature turns
//      on the hash conferring nothing.
//   4. THE POLLER CANNOT AUTO-APPROVE IT. This is the one that would have shipped
//      real balance out of thin air.
//   5. APPROVAL IS EXACTLY ONCE, AND GRANTS NOTHING — a customer who topped up
//      $10 must not receive a subscription.
//   6. A TOP-UP IS NOT A SUBSCRIPTION. `/api/billing/status` must never answer
//      with a top-up row.
//
// The wallet fakes THROW on any call, so "this route never moves money" is proven
// by the test passing rather than by the absence of an assertion.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const TOPUP_ROUTE = "/app/api/billing/topup/route.ts";
const STATUS_ROUTE = "/app/api/billing/status/route.ts";
const APPROVE_ROUTE = "/app/api/admin/payments/[id]/approve/route.ts";
const VERIFY_ROUTE = "/app/api/internal/payment-verify/route.ts";

/** A minimal NextResponse stand-in — the routes only ever return .json(...) bodies. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => data,
  }),
};

/** A request stand-in; `json()` is all the top-up route ever calls. */
const req = (body: unknown) => ({ json: async () => body }) as never;

interface Row {
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Dependency injection. `overrides` is consulted by the module loader and
// repopulated by `loadRoute()` just before each `require`, so several route
// modules coexist in one process with DIFFERENT fakes wired into each.
// ---------------------------------------------------------------------------

interface Overrides {
  [request: string]: unknown;
}

let overrides: Overrides = {};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (parent?.filename && request in overrides) {
    return overrides[request];
  }
  if (parent?.filename && request === "next/server") return { NextResponse: fakeNextResponse };
  return originalLoad.call(this, request, parent, isMain);
};

/** Require `path` fresh, with `deps` substituted for the named imports. */
function loadRoute(path: string, deps: Overrides) {
  // `path` is written the way the loader tests below refer to routes — an
  // absolute-looking `/app/...` — but `require.resolve` needs it relative to THIS
  // file, so the project root is prefixed rather than each constant carrying it.
  const abs = require.resolve(`..${path}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs);
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

// ---------------------------------------------------------------------------
// Fake prisma — records every query so a test can assert on the WHERE clause,
// which is where most of the real guarantees in this feature actually live.
// ---------------------------------------------------------------------------

function makePrisma(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const calls: Array<{ model: string; op: string; args: Row }> = [];
  const record = (model: string, op: string, args: Row) => {
    calls.push({ model, op, args });
  };
  const prisma = {
    payment: {
      create: async ({ data }: { data: Row }) => {
        record("payment", "create", { data });
        const row = { id: `pay_${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where?: Row } = {}) => {
        record("payment", "findFirst", { where });
        return rows.find((r) => matches(r, where)) ?? null;
      },
      findUnique: async ({ where }: { where?: Row } = {}) => {
        record("payment", "findUnique", { where });
        return rows.find((r) => matches(r, where)) ?? null;
      },
      findMany: async ({ where }: { where?: Row } = {}) => {
        record("payment", "findMany", { where });
        return rows.filter((r) => matches(r, where));
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        record("payment", "update", { where, data });
        const row = rows.find((r) => matches(r, where));
        if (!row) throw new Error("update: no such row");
        Object.assign(row, data);
        return row;
      },
    },
    paymentVerificationAttempt: {
      create: async ({ data }: { data: Row }) => {
        record("attempt", "create", { data });
        return { id: "att", ...data };
      },
    },
    // The AdminSetting singleton, as `upsert({ where, update, create })` — the
    // wallets settings route creates the row on first read and mutates it on
    // write, so a fake that only did `findUnique` would fail that route for a
    // reason that has nothing to do with the behaviour under test.
    adminSetting: {
      upsert: async ({ where, update, create }: { where: Row; update?: Row; create?: Row }) => {
        record("adminSetting", "upsert", { where, update, create });
        const existing = rows.find((r) => r.id === where.id);
        if (existing) {
          Object.assign(existing, update ?? {});
          return existing;
        }
        const row = { id: where.id, ...(create ?? {}) };
        rows.push(row);
        return row;
      },
    },
  };
  return { prisma, rows, calls };
}

/**
 * A deliberately small subset of Prisma's `where` — equality, plus the operator
 * forms these four queries actually use (`not`, `notIn`, `in`, `not: null`).
 *
 * It is small on purpose, but NOT so small that it can quietly return the wrong
 * row set: an earlier version understood only `product: { not }`, which made the
 * poller's query match NOTHING and would have let the auto-approval test pass for
 * entirely the wrong reason. A fake that under-matches is worse than no fake, so
 * every condition a test relies on is honoured here, and an operator nobody
 * anticipated THROWS rather than silently matching.
 */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const cond = v as { not?: unknown; notIn?: unknown[]; in?: unknown[] };
      if (cond.not !== undefined) {
        return cond.not === null ? row[k] !== null : row[k] !== cond.not;
      }
      if (cond.notIn !== undefined) return !cond.notIn.includes(row[k]);
      if (cond.in !== undefined) return cond.in.includes(row[k]);
      throw new Error(`fake prisma: unsupported operator for "${k}"`);
    }
    return row[k] === v;
  });
}

const SETTINGS = {
  btcWallet: "bc1qpay",
  usdtWallet: "TPay",
  usdtErc20Wallet: "0xErc",
  walletTopupMinUsd: 5,
  webSubscriptionPriceUsd: 20,
};

const fakeSettings = (over: Row = {}) => ({
  getAdminSettings: async () => ({ ...SETTINGS, ...over }),
});

/** Wallet fakes that MOVE MONEY. Reaching one must fail the test. */
const explodingWallet = (message: string) => ({
  creditApprovedPayment: () => {
    throw new Error(message);
  },
  topUp: () => {
    throw new Error(message);
  },
  grantBalance: () => {
    throw new Error(message);
  },
  adminAdjust: () => {
    throw new Error(message);
  },
  debitPurchase: () => {
    throw new Error(message);
  },
});

const NEVER = "POST /api/billing/topup must never move money";
const ALICE = { getSession: async () => ({ userId: "u_alice" }) };

/** The dependency set shared by every /api/billing/topup test. */
const topupDeps = (prisma: unknown, settings: Overrides): Overrides => ({
  "next/server": { NextResponse: fakeNextResponse },
  "@/lib/prisma": { prisma },
  "@/lib/session": ALICE,
  "@/lib/admin-settings": fakeSettings(settings),
  "@/lib/products": { WALLET_TOPUP_PRODUCT_ID: "wallet_topup" },
  "@/lib/wallet": explodingWallet(NEVER),
  "@/lib/license-service": {
    handleApprovedPayment: () => {
      throw new Error("POST /api/billing/topup must never grant a product");
    },
  },
});

beforeEach(() => {
  overrides = {};
});


// ---------------------------------------------------------------------------
// 1 & 2 — opening an order
// ---------------------------------------------------------------------------

test("a top-up below the CONFIGURED minimum is refused, and the message names it", async () => {
  // The floor is read from settings on every request, not captured at import. A
  // hardcoded $5 here would be the bug: the admin sets $25 in the settings tab,
  // the customer is still told $5, and a $10 order is created against a policy
  // that no longer exists.
  const { prisma, rows } = makePrisma();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, { walletTopupMinUsd: 25 }));

  const res = await POST(req({ amountUsd: 10 }));
  assert.equal(res.status, 400);
  const body = (await res.json()) as Row;
  assert.match(
    String(body.error),
    /25\.00/,
    "the error must name the CONFIGURED minimum, not a hardcoded $5",
  );
  assert.equal(rows.length, 0, "a refused top-up must not create a payment row");
});

test("the form's GET reports the CONFIGURED minimum and the sanity cap, and demands a session", async () => {
  // §4a: the floor must be SHOWN in the UI so the validation error never
  // surprises. These are the two numbers the form renders before the customer
  // types — a hardcoded $5 here would drift from the POST's actual rule the
  // moment the admin edits the settings tab.
  const { prisma } = makePrisma();

  // No session → 401, same contract as POST. The floor is harmless to display,
  // but a route that answers anonymous callers invites scraping for no benefit.
  const anonymous = loadRoute(TOPUP_ROUTE, {
    ...topupDeps(prisma, { walletTopupMinUsd: 25 }),
    "@/lib/session": { getSession: async () => null },
  });
  const denied = await anonymous.GET();
  assert.equal(denied.status, 401);

  const { GET } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, { walletTopupMinUsd: 25 }));
  const res = await GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.minimumUsd, 25, "the GET must report the configured floor");
  assert.equal(body.maximumUsd, 10_000, "the GET must report the POST's cap too");
});

test("the minimum is a floor, not a fixed amount: a larger top-up is allowed", async () => {
  const { prisma, rows } = makePrisma();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  const res = await POST(req({ amountUsd: 40 }));
  assert.equal(res.status, 200);
  assert.equal(rows[0].amountUsd, 40);
});

test("a valid top-up is created PENDING, for the session's user, and credits nothing", async () => {
  const { prisma, rows, calls } = makePrisma();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  const res = await POST(req({ amountUsd: 25, kind: "btc" }));

  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.status, "pending", "opening an order is not approval");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].product, "wallet_topup");
  assert.equal(rows[0].userId, "u_alice");
  assert.equal(rows[0].kind, "btc");
  // The payout address must be the CRYPTO address for the chosen chain, which is
  // not the SpaceWorker wallet — the two subsystems both say "wallet".
  assert.equal(rows[0].toAddress, "bc1qpay");
  // No hash yet: there is nothing on-chain to look up.
  assert.equal(rows[0].txHash, null);
  // An audit row exists before any money moves, so the admin queue shows intent.
  assert.ok(calls.some((c) => c.model === "attempt" && c.op === "create"));
});

test("a top-up with no session is refused", async () => {
  const { prisma, rows } = makePrisma();
  const { POST } = loadRoute(TOPUP_ROUTE, {
    ...topupDeps(prisma, {}),
    "@/lib/session": { getSession: async () => null },
  });

  const res = await POST(req({ amountUsd: 25 }));
  assert.equal(res.status, 401);
  assert.equal(rows.length, 0);
});

test("the invoice rounds UP to the cent, never down", async () => {
  // $25.001 must invoice $25.01. Rounding down would under-invoice, and the credit
  // is bounded by the invoice — so the shortfall would be the customer's, silently.
  const { prisma, rows } = makePrisma();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  await POST(req({ amountUsd: 25.001 }));
  assert.equal(rows[0].amountUsd, 25.01);
});

test("a non-numeric amount is refused rather than becoming NaN", async () => {
  const { prisma, rows } = makePrisma();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  // `Number(null)` is 0 and `Number("")` is 0, so the floor would catch those —
  // but `Number("abc")` is NaN, and NaN fails EVERY comparison, so the
  // finiteness check has to come before the minimum check or NaN sails through.
  for (const bad of ["abc", null, {}, true]) {
    const res = await POST(req({ amountUsd: bad }));
    assert.equal(res.status, 400, `amountUsd=${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// 3 — submitting a hash is still not approval
// ---------------------------------------------------------------------------

const openTopup = (over: Row = {}) =>
  makePrisma([
    {
      id: "pay_1",
      userId: "u_alice",
      product: "wallet_topup",
      status: "pending",
      txHash: null,
      kind: "usdt_trc20",
      toAddress: "TPay",
      amountUsd: 25,
      ...over,
    },
  ]);

test("submitting a hash leaves the top-up PENDING and credits nothing", async () => {
  const { prisma, rows } = openTopup();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  const res = await POST(req({ paymentId: "pay_1", txHash: "0xabc123" }));
  assert.equal(res.status, 200);
  assert.equal(rows[0].txHash, "0xabc123");
  assert.equal(
    rows[0].status,
    "pending",
    "a confirmed transaction is not an approved one — plan §8.6",
  );
});

test("submitting WITHOUT a hash is accepted and stays PENDING (owner: hash optional)", async () => {
  // TASK_185 follow-up — "even the hash is not required for topup": the admin
  // confirms every top-up by hand anyway, so an empty hash must reach the same
  // pending/manual-review state instead of 400-ing. Credits nothing.
  const { prisma, rows, calls } = openTopup();
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  const res = await POST(req({ paymentId: "pay_1", txHash: "" }));
  assert.equal(res.status, 200, "an empty hash must not be refused");
  assert.equal(rows[0].txHash, null, "no hash means NULL (multiple NULLs never collide)");
  assert.equal(rows[0].status, "pending");
  const attempt = calls.find((c) => c.model === "attempt");
  assert.ok(attempt, "a review note is recorded for the admin queue");
  assert.match(
    String((attempt?.args?.data as { note?: string } | undefined)?.note),
    /No transaction hash provided/,
  );
});

test("a customer cannot attach a hash to ANOTHER user's top-up", async () => {
  // The lookup is scoped by `userId` AND `product`. A bare findUnique on the id
  // would let one customer write into somebody else's open order.
  const { prisma, rows, calls } = openTopup({ id: "pay_9", userId: "u_victim" });
  const { POST } = loadRoute(TOPUP_ROUTE, {
    ...topupDeps(prisma, {}),
    "@/lib/session": { getSession: async () => ({ userId: "u_attacker" }) },
  });

  const res = await POST(req({ paymentId: "pay_9", txHash: "0xstolen" }));
  assert.equal(res.status, 404);
  assert.equal(rows[0].txHash, null, "the victim's row must be untouched");

  const lookup = calls.find((c) => c.op === "findFirst")!;
  assert.equal((lookup.args.where as Row).userId, "u_attacker");
  assert.equal((lookup.args.where as Row).product, "wallet_topup");
});

test("a hash already used by another payment is refused", async () => {
  // txHash is UNIQUE across the table. Reuse would mean one transaction counted as
  // payment twice — once for a subscription, once for a top-up.
  const { prisma, rows } = makePrisma([
    { id: "pay_1", userId: "u_alice", product: "wallet_topup", status: "pending", txHash: null, amountUsd: 25 },
    { id: "pay_2", userId: "u_bob", product: "web_subscription", status: "approved", txHash: "0xreused" },
  ]);
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  const res = await POST(req({ paymentId: "pay_1", txHash: "0xreused" }));
  assert.equal(res.status, 400);
  assert.equal(rows[0].txHash, null);
});

test("an approved top-up cannot be re-used as a hash target", async () => {
  // Its money is already in the wallet; a second hash on the same row would read
  // to an admin as fresh evidence for a credit that already happened.
  const { prisma } = openTopup({ status: "approved" });
  const { POST } = loadRoute(TOPUP_ROUTE, topupDeps(prisma, {}));

  const res = await POST(req({ paymentId: "pay_1", txHash: "0xagain" }));
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// 4 — the poller must never auto-approve a top-up
// ---------------------------------------------------------------------------

test("the internal verifier NEVER selects a wallet_topup, even when its hash is on-chain", async () => {
  // The highest-consequence guard in the feature. Every other pending payment is
  // approved the instant it verifies; a top-up must be exempt even when the chain
  // says the money arrived, because "confirmed" is not "ours" — an admin has to
  // read the row and agree.
  const { prisma, calls } = makePrisma([
    { id: "pay_1", userId: "u_alice", product: "wallet_topup", status: "pending", txHash: "0xonchain", kind: "usdt_trc20", toAddress: "TPay", amountUsd: 25, createdAt: new Date("2030-01-01") },
    { id: "pay_2", userId: "u_bob", product: "web_subscription", status: "pending", txHash: "0xsub", kind: "usdt_trc20", toAddress: "TPay", amountUsd: 20, createdAt: new Date("2030-01-02") },
  ]);
  const verified: string[] = [];
  let licenseCalls = 0;
  const { POST } = loadRoute(VERIFY_ROUTE, {
    "next/server": { NextResponse: fakeNextResponse },
    "@/lib/internal-auth": { requireInternalBearer: () => true },
    "@/lib/prisma": { prisma },
    "@/lib/crypto-verify": {
      verifyBtcPayment: async (hash: string) => {
        verified.push(hash);
        return { ok: true, note: "confirmed" };
      },
      verifyUsdtPayment: async (hash: string) => {
        verified.push(hash);
        return { ok: true, note: "confirmed" };
      },
      isPendingNote: () => false,
    },
    "@/lib/products": { WALLET_TOPUP_PRODUCT_ID: "wallet_topup" },
    "@/lib/license-service": {
      handleApprovedPayment: async () => {
        licenseCalls++;
      },
    },
  });

  const res = await POST(req({}));
  assert.equal(res.status, 200);

  // The exclusion must be in the QUERY, not a runtime `continue` — a row that is
  // selected and then skipped still records verification attempts and can still
  // be swept by the 24h auto-reject.
  const query = calls.find((c) => c.op === "findMany")!;
  assert.deepEqual(
    (query.args.where as Row).product,
    { not: "wallet_topup" },
    "the poller query must exclude wallet_topup",
  );
  assert.deepEqual(
    verified,
    ["0xsub"],
    "the top-up's on-chain hash must never be looked up by the auto-approver",
  );

  const topup = (await prisma.payment.findUnique({ where: { id: "pay_1" } }))!;
  assert.equal(topup.status, "pending", "a confirmed top-up must stay pending for a human");
  // The subscription was the only row the poller saw, and the real service does
  // the licensing — so exactly ONE grant is the correct outcome here. Asserting
  // `0` would have been asserting that the owner's actual business is broken.
  assert.equal(
    licenseCalls,
    1,
    "only the subscription may be auto-approved; the top-up drives no grant",
  );
});

// ---------------------------------------------------------------------------
// 5 — approval: exactly once, and grants nothing
// ---------------------------------------------------------------------------

interface Credit {
  paymentId: string;
  amountCents: number;
}

/** Fakes for the approve route; `onLicense` counts product grants. */
const approveDeps = (
  prisma: unknown,
  credit: (input: Credit) => unknown,
  onLicense: () => void,
): Overrides => ({
  "next/server": { NextResponse: fakeNextResponse },
  "@/lib/prisma": { prisma },
  "@/lib/admin-auth": { getAdminSession: async () => ({ id: "adm_1" }) },
  "@/lib/products": {
    WALLET_TOPUP_PRODUCT_ID: "wallet_topup",
    isWalletTopup: (p: string) => p === "wallet_topup",
  },
  "@/lib/wallet": { creditApprovedPayment: credit },
  "@/lib/license-service": { handleApprovedPayment: async () => onLicense() },
});

const pendingTopup = (over: Row = {}) =>
  makePrisma([
    {
      id: "pay_1",
      userId: "u_alice",
      product: "wallet_topup",
      status: "pending",
      txHash: "0xonchain",
      amountUsd: 25,
      ...over,
    },
  ]);

const okCredit = (credits: Credit[]) => async (input: Credit) => {
  credits.push({ paymentId: input.paymentId, amountCents: input.amountCents });
  return { ok: true, value: { amountCents: input.amountCents, balanceCents: 2500 } };
};

const approveParams = (id: string) => ({ params: Promise.resolve({ id }) });

test("approving a top-up credits the wallet and NEVER calls handleApprovedPayment", async () => {
  const { prisma, rows } = pendingTopup();
  const credits: Credit[] = [];
  let licenseCalls = 0;
  const { POST } = loadRoute(
    APPROVE_ROUTE,
    approveDeps(prisma, okCredit(credits), () => {
      licenseCalls++;
    }),
  );

  const res = await POST(req({}), approveParams("pay_1"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.creditedCents, 2500);
  assert.equal(body.balanceCents, 2500);
  // Dollars→cents, rounded up, matching the invoice the credit is bounded by.
  assert.deepEqual(credits, [{ paymentId: "pay_1", amountCents: 2500 }]);
  assert.equal(
    licenseCalls,
    0,
    "a customer who topped up $10 must not receive a subscription or a licence",
  );
  assert.equal(rows[0].status, "approved");
});

test("a second approval of the same top-up is refused BEFORE the credit is attempted", async () => {
  // Two guards protect this button: the route's own status check, and the UNIQUE
  // index on paymentId behind `creditApprovedPayment`. This asserts the first; the
  // second is a real constraint, replayed in scripts/replay-wallet-migration.sh.
  const { prisma } = pendingTopup();
  const credits: Credit[] = [];
  const { POST } = loadRoute(APPROVE_ROUTE, approveDeps(prisma, okCredit(credits), () => {}));

  assert.equal((await POST(req({}), approveParams("pay_1"))).status, 200);

  const second = await POST(req({}), approveParams("pay_1"));
  assert.equal(second.status, 400);
  assert.equal(credits.length, 1, "a replayed approval must not credit a second time");
});

test("a failed credit leaves the payment NON-approved, so the admin can retry", async () => {
  // The status flip happens AFTER the credit. Marking it approved and then failing
  // would show the admin "approved" for a customer who has no money — the exact
  // state plan §8.5 exists to prevent.
  const { prisma, rows } = pendingTopup();
  const { POST } = loadRoute(
    APPROVE_ROUTE,
    approveDeps(
      prisma,
      async () => ({
        ok: false,
        status: 422,
        message: "That payment has already been credited in full.",
      }),
      () => {},
    ),
  );

  const res = await POST(req({}), approveParams("pay_1"));
  assert.equal(res.status, 422);
  assert.equal(rows[0].status, "pending", "a failed credit must not mark the payment approved");
});

test("a non-admin cannot approve a top-up", async () => {
  const { prisma } = pendingTopup();
  const { POST } = loadRoute(APPROVE_ROUTE, {
    ...approveDeps(prisma, okCredit([]), () => {}),
    "@/lib/admin-auth": { getAdminSession: async () => null },
    "@/lib/wallet": explodingWallet("only an admin may credit a wallet"),
  });

  assert.equal((await POST(req({}), approveParams("pay_1"))).status, 403);
});

test("a SUBSCRIPTION approval still goes through handleApprovedPayment", async () => {
  // The guard against over-correction: adding a top-up branch must not have
  // changed what a subscription does. This is the owner's actual business.
  const { prisma, rows } = pendingTopup({
    id: "pay_2",
    userId: "u_bob",
    product: "web_subscription",
    amountUsd: 20,
  });
  let licenseCalls = 0;
  const { POST } = loadRoute(
    APPROVE_ROUTE,
    approveDeps(
      prisma,
      explodingWallet("a subscription must not touch the wallet") as never,
      () => {
        licenseCalls++;
      },
    ),
  );

  const res = await POST(req({}), approveParams("pay_2"));
  assert.equal(res.status, 200);
  assert.equal(licenseCalls, 1);
  assert.equal(rows[0].status, "approved");
});

// ---------------------------------------------------------------------------
// 6 — a top-up is not a subscription
// ---------------------------------------------------------------------------

const statusDeps = (prisma: unknown): Overrides => ({
  "next/server": { NextResponse: fakeNextResponse },
  "@/lib/prisma": { prisma },
  "@/lib/session": ALICE,
  "@/lib/products": { WALLET_TOPUP_PRODUCT_ID: "wallet_topup" },
});

test("/api/billing/status never reports a top-up as the user's subscription", async () => {
  // The newest payment for this user is a top-up. The "Upgrade to Pro" card would
  // otherwise render it as a pending Pro purchase — a product they did not buy,
  // shown to them, inviting a duplicate payment.
  const { prisma, calls } = makePrisma([
    { id: "pay_1", userId: "u_alice", product: "wallet_topup", status: "pending", amountUsd: 25, createdAt: new Date("2030-01-02") },
    { id: "pay_2", userId: "u_alice", product: "web_subscription", status: "approved", amountUsd: 20, createdAt: new Date("2030-01-01") },
  ]);
  const { GET } = loadRoute(STATUS_ROUTE, statusDeps(prisma));

  const res = await GET();
  const body = (await res.json()) as Row;

  const query = calls.find((c) => c.op === "findFirst")!;
  assert.deepEqual(
    (query.args.where as Row).product,
    { not: "wallet_topup" },
    "the status query must exclude top-ups",
  );
  // It returns the older SUBSCRIPTION, not the newer top-up.
  assert.equal(body.id, "pay_2");
});

test("/api/billing/status reports null for a user whose only payment is a top-up", async () => {
  // A user who has topped up and never subscribed must see no pending Pro
  // purchase. Returning the top-up would be the same lie in a different shape.
  const { prisma } = makePrisma([
    { id: "pay_1", userId: "u_alice", product: "wallet_topup", status: "pending", amountUsd: 25 },
  ]);
  const { GET } = loadRoute(STATUS_ROUTE, statusDeps(prisma));

  assert.deepEqual(await (await GET()).json(), { status: null });
});

test("/api/billing/status with no session is refused", async () => {
  const { prisma } = makePrisma([
    { id: "pay_1", userId: "u_alice", product: "web_subscription", status: "approved", amountUsd: 20 },
  ]);
  const { GET } = loadRoute(STATUS_ROUTE, {
    ...statusDeps(prisma),
    "@/lib/session": { getSession: async () => null },
  });

  assert.equal((await GET()).status, 401);
});

// ---------------------------------------------------------------------------
// 7 — the admin settings surface the minimum the route enforces
// ---------------------------------------------------------------------------

test("the admin wallets API reads AND writes the same minimum the top-up route enforces", async () => {
  // The one way this feature rots silently: an admin sets $25 in the settings tab,
  // the PUT reports "saved", and the top-up route still enforces $5 because the two
  // read different fields. Asserting the round-trip is what keeps them the same
  // field. The validation is asserted here too, because an unchecked `0` would
  // reach the migration's CHECK constraint and surface as an opaque 500.
  const { prisma, rows, calls } = makePrisma([
    { id: "singleton", btcWallet: "bc1qpay", usdtWallet: "TPay", usdtErc20Wallet: "0xErc", walletTopupMinUsd: 5 },
  ]);
  // Loaded and destructured in two steps, with the module's type cast explicit.
  // Reading `.json` off a response is a Promise, and folding that into a
  // conditional expression here reads as though it were synchronous.
  const mod = loadRoute("/app/api/admin/wallets/route.ts", {
    "next/server": { NextResponse: fakeNextResponse },
    "@/lib/prisma": { prisma },
    "@/lib/admin-auth": { getAdminSession: async () => ({ id: "adm_1" }) },
  });
  const { GET, PUT } = mod as {
    GET: () => Promise<Response>;
    PUT: (r: never) => Promise<Response>;
  };

  const read = (await (await GET()).json()) as Row;
  assert.equal(read.walletTopupMinUsd, 5, "the API must expose the configured floor");

  const saved = await PUT(req({ walletTopupMinUsd: 25 }) as never);
  assert.equal(saved.status, 200);
  const savedBody = (await saved.json()) as Row;
  assert.equal(savedBody.walletTopupMinUsd, 25, "the API must echo back what it stored");
  assert.equal(rows[0].walletTopupMinUsd, 25);
  assert.ok(
    calls.some((c) => c.model === "adminSetting"),
    "the write must go through the singleton upsert",
  );

  // A non-positive minimum is refused with a message, not left to the database.
  for (const bad of [0, -1, "abc", null]) {
    const res = await PUT(req({ walletTopupMinUsd: bad }) as never);
    assert.equal(res.status, 400, `walletTopupMinUsd=${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(rows[0].walletTopupMinUsd, 25, "a refused write must not change the stored floor");
});

test("a non-admin cannot read or change the top-up minimum", async () => {
  const { prisma } = makePrisma([{ id: "singleton", walletTopupMinUsd: 5 }]);
  const { GET, PUT } = loadRoute("/app/api/admin/wallets/route.ts", {
    "next/server": { NextResponse: fakeNextResponse },
    "@/lib/prisma": { prisma },
    "@/lib/admin-auth": { getAdminSession: async () => null },
  });

  assert.equal((await GET()).status, 403);
  assert.equal((await PUT(req({ walletTopupMinUsd: 1 }))).status, 403);
});
