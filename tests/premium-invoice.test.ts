import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_184 B5 (MONEY) — the premium-invoice lifecycle against a fake db:
// admin sends → user pays → approval settles → the invoice's tier is granted.
//
// THE FAILURES THIS SUITE EXISTS TO PREVENT:
//   1. DOUBLE GRANT — handleApprovedPayment settling the invoice AND running
//      the product branch would stack two terms on one payment. Exactly ONE
//      grant may leave an approval (the settle path OR the product path).
//   2. CLIENT-CONTROLLED ECONOMICS — tier derived from plan (a body tier is
//      ignored), amount defaulted + validated server-side, payout addresses
//      SNAPSHOT at send; submit reads the invoice's snapshot even after the
//      admin rotates a wallet, and body.product never reaches the row.
//   3. FORGED / DOUBLE SETTLE — a ref for someone else's invoice, a re-approve,
//      or a lost claim race must settle/grant NOTHING (claim-THEN-grant:
//      updateMany count 0 ⇒ no grant).
//   4. WALLET INVERSION — an invoice payment riding the top-up rail must never
//      credit the wallet; a plain top-up must still credit (B4 fall-through).
//
// House pattern (wallet-grant-route / module-route-gate): Module._load hook +
// fake prisma + `server-only` stub; REAL license-service under test, its
// ./premium grant functions swapped for recorders.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

const CREATE_ROUTE = "/app/api/admin/users/[id]/invoices/route.ts";
const PATCH_ROUTE = "/app/api/admin/users/[id]/invoices/[invoiceId]/route.ts";
const USER_INVOICES_ROUTE = "/app/api/billing/invoices/route.ts";
const SUBMIT_ROUTE = "/app/api/billing/submit/route.ts";
const APPROVE_ROUTE = "/app/api/admin/payments/[id]/approve/route.ts";
const LICENSE_SERVICE = "/lib/license-service.ts";
const PRODUCTS_MODULE = "/lib/products.ts";

/** Minimal NextResponse stand-in — every return here is `.json(...)`. */
const fakeNextResponse = {
  json: (data: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    body: data,
    json: async () => data,
  }),
};

/** Request stand-in; json() is all these routes ever call. */
const req = (body: unknown) => ({ json: async () => body });

interface Overrides {
  [request: string]: unknown;
}
interface FakeRes {
  status: number;
  body: unknown;
  json: () => Promise<unknown>;
}
type Handler = (r?: unknown, ctx?: unknown) => Promise<FakeRes>;

let overrides: Overrides = {};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  if (parent?.filename && request in overrides) return overrides[request];
  if (parent?.filename && request === "next/server") return { NextResponse: fakeNextResponse };
  return originalLoad.call(this, request, parent, isMain);
};

/** Require a route/lib file fresh with `deps` substituted for its imports. */
function loadRoute(path: string, deps: Overrides): Record<string, Handler> {
  const abs = require.resolve(`..${path}`);
  delete require.cache[abs];
  overrides = deps;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return require(abs) as Record<string, Handler>;
    /* eslint-enable @typescript-eslint/no-require-imports */
  } finally {
    overrides = {};
  }
}

// ---- the shared fake db ----------------------------------------------------

interface InvoiceRow {
  id: string;
  userId: string;
  plan: string;
  tier: number;
  amountUsd: number;
  methods: Record<string, string | null>;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
}

interface PaymentRow {
  id: string;
  userId: string | null;
  kind: string;
  product: string;
  amountUsd: number;
  durationDays: number | null;
  txHash: string | null;
  toAddress: string | null;
  status: string;
  invoiceId: string | null;
}

interface AttemptRow {
  paymentId: string;
  success: boolean;
  note: string;
}

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}_${++idSeq}`;

const store: {
  users: { id: string }[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  attempts: AttemptRow[];
  lastFindManyArgs: Record<string, unknown> | null;
  loseClaimRace: boolean;
} = {
  users: [],
  invoices: [],
  payments: [],
  attempts: [],
  lastFindManyArgs: null,
  loseClaimRace: false,
};

function pick(row: Record<string, unknown>, select?: Record<string, boolean>): unknown {
  if (!select) return { ...row };
  const picked: Record<string, unknown> = {};
  for (const k of Object.keys(select)) if (select[k]) picked[k] = row[k];
  return picked;
}

/** The app-wide prisma singleton, as both `@/lib/prisma` and license-service's `./db`. */
const prisma = {
  user: {
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const u = store.users.find((x) => x.id === args.where.id);
      return u ? pick(u as unknown as Record<string, unknown>, args.select) : null;
    },
  },
  premiumInvoice: {
    findUnique: async (args: { where: { id: string }; select?: Record<string, boolean> }) => {
      const inv = store.invoices.find((x) => x.id === args.where.id);
      return inv ? pick(inv as unknown as Record<string, unknown>, args.select) : null;
    },
    findFirst: async (args: {
      where: { userId: string; status: string };
      select?: Record<string, boolean>;
    }) => {
      const inv = store.invoices.find(
        (x) => x.userId === args.where.userId && x.status === args.where.status,
      );
      return inv ? pick(inv as unknown as Record<string, unknown>, args.select) : null;
    },
    findMany: async (args: {
      where?: { userId?: string };
      orderBy?: { createdAt: string };
      take?: number;
      select?: Record<string, boolean>;
    }) => {
      store.lastFindManyArgs = args;
      let rows = store.invoices.slice();
      if (args.where?.userId) rows = rows.filter((x) => x.userId === args.where?.userId);
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows.map((r) => ({ ...r }));
    },
    create: async (args: {
      data: { userId: string; plan: string; tier: number; amountUsd: number; methods: Record<string, string | null> };
    }) => {
      const row: InvoiceRow = {
        id: nextId("inv"),
        status: "open",
        paidAt: null,
        createdAt: new Date(Date.now() + idSeq),
        ...args.data,
      };
      store.invoices.push(row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Partial<InvoiceRow> }) => {
      const inv = store.invoices.find((x) => x.id === args.where.id);
      if (!inv) throw new Error(`invoice ${args.where.id} not found`);
      Object.assign(inv, args.data);
      return { ...inv };
    },
    // The CLAIM in settleLinkedInvoice — honors the real filters AND an
    // injectable lost-race, because grant-after-claim is the whole point.
    updateMany: async (args: { where: { id: string; status: string }; data: Partial<InvoiceRow> }) => {
      if (store.loseClaimRace) return { count: 0 };
      let count = 0;
      for (const inv of store.invoices) {
        if (inv.id === args.where.id && inv.status === args.where.status) {
          Object.assign(inv, args.data);
          count += 1;
        }
      }
      return { count };
    },
  },
  payment: {
    findUnique: async (args: { where: { id?: string; txHash?: string } }) => {
      const row =
        args.where.txHash !== undefined
          ? store.payments.find((x) => x.txHash === args.where.txHash)
          : store.payments.find((x) => x.id === args.where.id);
      return row ? { ...row } : null;
    },
    create: async (args: { data: Partial<PaymentRow> & { userId: string | null } }) => {
      const row: PaymentRow = {
        id: nextId("pay"),
        kind: "btc",
        product: "web_subscription",
        amountUsd: 0,
        durationDays: null,
        txHash: null,
        toAddress: null,
        status: "pending",
        invoiceId: null,
        ...args.data,
      };
      store.payments.push(row);
      return { ...row };
    },
    update: async (args: { where: { id: string }; data: Partial<PaymentRow> }) => {
      const row = store.payments.find((x) => x.id === args.where.id);
      if (!row) throw new Error(`payment ${args.where.id} not found`);
      Object.assign(row, args.data);
      return { ...row };
    },
  },
  paymentVerificationAttempt: {
    create: async (args: { data: AttemptRow }) => {
      store.attempts.push(args.data);
      return { id: nextId("att"), ...args.data };
    },
  },
};

// ---- module shims ----------------------------------------------------------

type AdminSettings = {
  webSubscriptionPriceUsd: number;
  xdevicePriceUsd: number;
  btcWallet: string | null;
  usdtWallet: string | null;
  usdtErc20Wallet: string | null;
};

/** The addresses the invoice is created WITH — later rotation must not matter. */
const SNAPSHOT: Record<string, string | null> = {
  btc: "BTC_AT_SEND",
  usdt_trc20: "TRC_AT_SEND",
  usdt_erc20: "ERC_AT_SEND",
};

const DEFAULT_SETTINGS: AdminSettings = {
  webSubscriptionPriceUsd: 79.97,
  xdevicePriceUsd: 29,
  btcWallet: "BTC_ADMIN",
  usdtWallet: "TRC_ADMIN",
  usdtErc20Wallet: "ERC_ADMIN",
};

let settings: AdminSettings = { ...DEFAULT_SETTINGS };
let session: { userId: string } | null = null;
let isAdmin = true;

interface Grant {
  fn: "grantPremium" | "grantXDeviceTerm";
  userId: string;
  days: number | undefined;
}
const grants: Grant[] = [];
const creditCalls: Array<Record<string, unknown>> = [];
const notifyCalls: Array<Record<string, unknown>> = [];

const PRISMA_SHIM = { prisma };
const SESSION_SHIM = { getSession: async () => session };
const ADMIN_SHIM = { getAdminSession: async () => (isAdmin ? { sub: "admin" } : null) };
const SETTINGS_SHIM = { getAdminSettings: async () => ({ ...settings }) };

/** REAL products (pure) — the derive-on-invoice logic under test needs it. */
const realProducts = loadRoute(PRODUCTS_MODULE, { "server-only": {} });

/** The real license-service with its private imports swapped for recorders. */
function loadLicenseService(): {
  settleLinkedInvoice: (p: { id: string; userId: string; invoiceId: string | null }) => Promise<boolean>;
  handleApprovedPayment: (paymentId: string) => Promise<void>;
} {
  return loadRoute(LICENSE_SERVICE, {
    "server-only": {},
    "./db": { db: prisma },
    "./email": { sendEmail: async () => {}, exeLicenseIssuedEmailHtml: () => "" },
    "./exe-license": { generateLicenseKey: () => "LIC-TEST" },
    "./license-claim": {
      generateLicenseClaimToken: () => "tok",
      hashLicenseClaimToken: () => "hashed",
      LICENSE_CLAIM_TTL_MS: 900_000,
    },
    "./products": realProducts,
    "./env": { env: {} },
    "./premium": {
      grantPremium: async (userId: string, days?: number) => {
        grants.push({ fn: "grantPremium", userId, days });
      },
      grantXDeviceTerm: async (userId: string, days?: number) => {
        grants.push({ fn: "grantXDeviceTerm", userId, days });
      },
      PREMIUM_DAYS_PER_CHARGE: 30,
    },
    "./entitlements": { grantEntitlement: async () => {} },
  }) as unknown as ReturnType<typeof loadLicenseService>;
}

function adminInvoiceDeps(): Overrides {
  return { "@/lib/prisma": PRISMA_SHIM, "@/lib/admin-auth": ADMIN_SHIM, "@/lib/admin-settings": SETTINGS_SHIM };
}

function userInvoicesDeps(): Overrides {
  return { "@/lib/prisma": PRISMA_SHIM, "@/lib/session": SESSION_SHIM };
}

function submitDeps(extra: Overrides = {}): Overrides {
  return {
    "@/lib/prisma": PRISMA_SHIM,
    "@/lib/session": SESSION_SHIM,
    "@/lib/admin-settings": SETTINGS_SHIM,
    "@/lib/crypto-verify": {
      verifyBtcPayment: async () => null,
      verifyUsdtPayment: async () => null,
      isPendingNote: () => false,
    },
    "@/lib/license-service": { handleApprovedPayment: async () => {} },
    "@/lib/find-or-create-user": { findOrCreateUser: async () => ({ userId: "u1" }) },
    "@/lib/rate-limit": { allowAndRecord: async () => true, getClientIp: async () => "127.0.0.1" },
    "@/lib/payment-notify": {
      notifyAdminPendingPayment: async (input: Record<string, unknown>) => {
        notifyCalls.push(input);
      },
    },
    "@/lib/products": realProducts,
    ...extra,
  };
}

function approveDeps(licenseService: unknown, wallet: Overrides): Overrides {
  return {
    "@/lib/prisma": PRISMA_SHIM,
    "@/lib/admin-auth": ADMIN_SHIM,
    "@/lib/license-service": licenseService,
    "@/lib/wallet": wallet,
    "@/lib/products": realProducts,
  };
}

const noWalletCredit = {
  creditApprovedPayment: async (input: Record<string, unknown>) => {
    creditCalls.push(input);
    return {
      ok: true,
      value: { amountCents: input.amountCents, balanceCents: input.amountCents },
    };
  },
};

// ---- seeds + reset ---------------------------------------------------------

function seedInvoice(p: Partial<InvoiceRow> & { id: string }): InvoiceRow {
  idSeq += 1;
  const row: InvoiceRow = {
    userId: "u1",
    plan: "premium_plus",
    tier: 5,
    amountUsd: 79.97,
    methods: { ...SNAPSHOT },
    status: "open",
    paidAt: null,
    createdAt: new Date(Date.now() + idSeq),
    ...p,
  };
  store.invoices.push(row);
  return row;
}

function seedPayment(p: Partial<PaymentRow> & { id: string }): PaymentRow {
  const row: PaymentRow = {
    userId: "u1",
    kind: "btc",
    product: "web_subscription",
    amountUsd: 79.97,
    durationDays: null,
    txHash: null,
    toAddress: "BTC_AT_SEND",
    status: "pending",
    invoiceId: null,
    ...p,
  };
  store.payments.push(row);
  return row;
}

function resetStore(): void {
  idSeq = 0;
  store.users = [{ id: "u1" }, { id: "u2" }];
  store.invoices = [];
  store.payments = [];
  store.attempts = [];
  store.lastFindManyArgs = null;
  store.loseClaimRace = false;
  grants.length = 0;
  creditCalls.length = 0;
  notifyCalls.length = 0;
  settings = { ...DEFAULT_SETTINGS };
  session = null;
  isAdmin = true;
}

beforeEach(resetStore);

/** Route ctx — params is a PROMISE in Next 16; both routes await it. */
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

// ---------------------------------------------------------------------------
// B3 — ADMIN CREATE / RE-EDIT (the money rules live server-side)
// ---------------------------------------------------------------------------

test("non-admin session can neither create nor read invoices (403, nothing written)", async () => {
  isAdmin = false;
  const route = loadRoute(CREATE_ROUTE, adminInvoiceDeps());
  const post = await route.POST(req({ plan: "premium_plus" }), ctx({ id: "u1" }));
  assert.equal(post.status, 403);
  const get = await route.GET(req({}), ctx({ id: "u1" }));
  assert.equal(get.status, 403);
  assert.equal(store.invoices.length, 0, "403 must happen before any write");
});

test("POST derives tier from plan — a client-sent tier is ignored (plus=5, xdevice=3)", async () => {
  const { POST } = loadRoute(CREATE_ROUTE, adminInvoiceDeps());

  const plus = await POST(req({ plan: "premium_plus", tier: 3 }), ctx({ id: "u1" }));
  assert.equal(plus.status, 201);
  const a = (plus.body as { invoice: InvoiceRow }).invoice;
  assert.equal(a.plan, "premium_plus");
  assert.equal(a.tier, 5, "tier 5 comes from PLANS[plan] — body.tier never reaches the row");
  assert.equal(a.status, "open");
  assert.equal(a.amountUsd, 79.97, "no amount ⇒ the plan's configured default");

  // Settle the first so the one-open guard lets the second through.
  store.invoices[0].status = "paid";
  const xd = await POST(req({ plan: "premium_xdevice", tier: 99 }), ctx({ id: "u1" }));
  assert.equal(xd.status, 201);
  const b = (xd.body as { invoice: InvoiceRow }).invoice;
  assert.equal(b.tier, 3, "premium_xdevice grants tier 3");
  assert.equal(b.amountUsd, 29, "each plan defaults to its OWN configured price");
});

test("POST defaults amountUsd to the configured plan price and validates every override", async () => {
  const { POST } = loadRoute(CREATE_ROUTE, adminInvoiceDeps());

  for (const bad of [0, -5, "abc", 100001, null]) {
    const res = await POST(req({ plan: "premium_plus", amountUsd: bad }), ctx({ id: "u1" }));
    assert.equal(res.status, 400, `amountUsd ${String(bad)} must be refused`);
    assert.equal(store.invoices.length, 0, "a refused amount must write nothing");
  }

  const ok = await POST(req({ plan: "premium_plus", amountUsd: 49 }), ctx({ id: "u1" }));
  assert.equal(ok.status, 201);
  assert.equal(store.invoices[0].amountUsd, 49, "the admin's edited amount stands");
});

test("POST snapshots the payout methods from settings — never the request body", async () => {
  const { POST } = loadRoute(CREATE_ROUTE, adminInvoiceDeps());
  const res = await POST(
    req({
      plan: "premium_plus",
      methods: { btc: "ATTACKER_ADDR", usdt_trc20: "EVIL", usdt_erc20: "MORE_EVIL" },
    }),
    ctx({ id: "u1" }),
  );
  assert.equal(res.status, 201);
  const invoice = (res.body as { invoice: InvoiceRow }).invoice;
  assert.deepEqual(
    invoice.methods,
    { btc: "BTC_ADMIN", usdt_trc20: "TRC_ADMIN", usdt_erc20: "ERC_ADMIN" },
    "methods come from AdminSettings at send time; the body's copy is ignored",
  );
});

test("POST enforces ONE open invoice per user and points at the existing row", async () => {
  const { POST } = loadRoute(CREATE_ROUTE, adminInvoiceDeps());

  const first = await POST(req({ plan: "premium_plus" }), ctx({ id: "u1" }));
  assert.equal(first.status, 201);
  const firstId = (first.body as { invoice: InvoiceRow }).invoice.id;

  const second = await POST(req({ plan: "premium_xdevice" }), ctx({ id: "u1" }));
  assert.equal(second.status, 400);
  const body = second.body as { error: string; invoiceId?: string };
  assert.match(body.error, /already has an open invoice/);
  assert.equal(body.invoiceId, firstId, "the admin is sent back to EDIT that row");
  assert.equal(store.invoices.length, 1, "no second contradictory amount may exist");

  const other = await POST(req({ plan: "premium_xdevice" }), ctx({ id: "u2" }));
  assert.equal(other.status, 201, "the guard is per user, not global");
  assert.equal(store.invoices.length, 2);
});

test("POST refuses an unknown plan (400) and an unknown user (404)", async () => {
  const { POST } = loadRoute(CREATE_ROUTE, adminInvoiceDeps());
  assert.equal((await POST(req({ plan: "premium" }), ctx({ id: "u1" }))).status, 400);
  assert.equal((await POST(req({}), ctx({ id: "u1" }))).status, 400);
  assert.equal((await POST(req({ plan: "premium_plus" }), ctx({ id: "ghost" }))).status, 404);
  assert.equal(store.invoices.length, 0);
});

test("PATCH re-derives tier on a plan switch while open; a settled invoice is frozen (409)", async () => {
  seedInvoice({ id: "inv_open", userId: "u1", plan: "premium_plus", tier: 5, amountUsd: 79.97 });
  const { PATCH } = loadRoute(PATCH_ROUTE, adminInvoiceDeps());

  const res = await PATCH(
    req({ amountUsd: 49, plan: "premium_xdevice" }),
    ctx({ id: "u1", invoiceId: "inv_open" }),
  );
  assert.equal(res.status, 200);
  const updated = (res.body as { invoice: InvoiceRow }).invoice;
  assert.equal(updated.amountUsd, 49);
  assert.equal(updated.plan, "premium_xdevice");
  assert.equal(updated.tier, 3, "tier re-derives WITH the plan — never read from the body");
  assert.deepEqual(
    updated.methods,
    SNAPSHOT,
    "a plan switch does NOT re-snapshot addresses mid-flight",
  );

  store.invoices[0].status = "paid";
  store.invoices[0].paidAt = new Date();
  const frozen = await PATCH(req({ amountUsd: 1 }), ctx({ id: "u1", invoiceId: "inv_open" }));
  assert.equal(frozen.status, 409);
  assert.equal(store.invoices[0].amountUsd, 49, "a settled invoice keeps its evidence");
});

test("PATCH rejects empty/invalid bodies and cross-user invoice ids", async () => {
  seedInvoice({ id: "inv_a", userId: "u1" });
  const { PATCH } = loadRoute(PATCH_ROUTE, adminInvoiceDeps());

  assert.equal((await PATCH(req({}), ctx({ id: "u1", invoiceId: "inv_a" }))).status, 400);
  assert.equal((await PATCH(req({ plan: "premium" }), ctx({ id: "u1", invoiceId: "inv_a" }))).status, 400);
  assert.equal((await PATCH(req({ amountUsd: -1 }), ctx({ id: "u1", invoiceId: "inv_a" }))).status, 400);
  assert.equal((await PATCH(req({ amountUsd: 5 }), ctx({ id: "u2", invoiceId: "inv_a" }))).status, 404);
  assert.equal(store.invoices[0].amountUsd, 79.97, "nothing reached the update");

  isAdmin = false;
  assert.equal((await PATCH(req({ amountUsd: 5 }), ctx({ id: "u1", invoiceId: "inv_a" }))).status, 403);
});

// ---------------------------------------------------------------------------
// B4 — THE USER'S OWN READ (session-scoped; the where-clause IS the authz)
// ---------------------------------------------------------------------------

test("GET /api/billing/invoices is 401 for anon before any db read", async () => {
  seedInvoice({ id: "inv_mine", userId: "u1" });
  store.lastFindManyArgs = null;
  const { GET } = loadRoute(USER_INVOICES_ROUTE, userInvoicesDeps());
  const res = await GET();
  assert.equal(res.status, 401);
  assert.equal(store.lastFindManyArgs, null, "no query may run without a session");
});

test("GET /api/billing/invoices is owner-scoped, capped at 10, never exposing updatedAt", async () => {
  seedInvoice({ id: "inv_u1", userId: "u1" });
  seedInvoice({ id: "inv_u2", userId: "u2" });
  session = { userId: "u1" };

  const { GET } = loadRoute(USER_INVOICES_ROUTE, userInvoicesDeps());
  const res = await GET();
  assert.equal(res.status, 200);
  const body = res.body as { invoices: InvoiceRow[] };
  assert.deepEqual(
    body.invoices.map((i) => i.id),
    ["inv_u1"],
    "the other user's money row must be invisible — where.userId is the authorization",
  );

  const args = store.lastFindManyArgs as {
    where: { userId: string };
    take: number;
    select: Record<string, boolean>;
  };
  assert.equal(args.where.userId, "u1");
  assert.equal(args.take, 10, "newest-first, capped at 10");
  assert.deepEqual(
    Object.keys(args.select).sort(),
    ["amountUsd", "createdAt", "id", "methods", "paidAt", "plan", "status", "tier"],
    "exactly the user's fields — updatedAt would leak the admin's edit history",
  );
  assert.ok(!("updatedAt" in args.select));
});

// ---------------------------------------------------------------------------
// B4 — SUBMIT: the invoice owns the economics of its payment
// ---------------------------------------------------------------------------

test("submit with an invoice ref is 401 without a session, even with a valid id", async () => {
  seedInvoice({ id: "inv_1", userId: "u1" });
  const { POST } = loadRoute(SUBMIT_ROUTE, submitDeps());
  const res = await POST(req({ kind: "btc", invoiceId: "inv_1" }));
  assert.equal(res.status, 401);
  assert.equal(store.payments.length, 0, "no payment row without an account to settle into");
});

test("submit refuses another user's invoice and an already-settled one", async () => {
  seedInvoice({ id: "inv_u1", userId: "u1" });
  seedInvoice({ id: "inv_paid", userId: "u1", status: "paid", paidAt: new Date() });
  const { POST } = loadRoute(SUBMIT_ROUTE, submitDeps());

  session = { userId: "u2" }; // valid session, NOT the invoice's owner
  const foreign = await POST(req({ kind: "btc", invoiceId: "inv_u1" }));
  assert.equal(foreign.status, 400);
  assert.match((foreign.body as { error: string }).error, /not found/);

  session = { userId: "u1" };
  const settled = await POST(req({ kind: "btc", invoiceId: "inv_paid" }));
  assert.equal(settled.status, 400);
  assert.match((settled.body as { error: string }).error, /already settled/);
  assert.equal(store.payments.length, 0, "a refused ref must write nothing");
});

test("submit: the invoice owns product, amount and destination — body ignored, snapshot survives rotation", async () => {
  seedInvoice({ id: "inv_1", userId: "u1", amountUsd: 65 });
  settings.btcWallet = "BTC_ROTATED_AFTER_SEND"; // admin rotates AFTER sending
  session = { userId: "u1" };

  const { POST } = loadRoute(SUBMIT_ROUTE, submitDeps());
  const res = await POST(req({ kind: "btc", product: "wallet_topup", invoiceId: "inv_1" }));
  assert.equal(res.status, 200);
  const body = res.body as { paymentId: string; status: string };
  const payment = store.payments.find((p) => p.id === body.paymentId);
  assert.ok(payment, "the payment row exists");
  assert.equal(
    payment.product,
    "web_subscription",
    "product derived from plan — body.product never reaches the row, or approval fires the wrong consequence",
  );
  assert.equal(
    payment.amountUsd,
    65,
    "the admin-edited invoice amount, not today's list price (79.97)",
  );
  assert.equal(
    payment.toAddress,
    "BTC_AT_SEND",
    "the SNAPSHOT the user was shown — not the rotated BTC_ROTATED_AFTER_SEND",
  );
  assert.equal(payment.invoiceId, "inv_1");
  assert.equal(payment.status, "pending");
  assert.equal(body.status, "pending");
  assert.equal(store.attempts.length, 1);
  assert.match(store.attempts[0].note, /awaiting manual review/);
  assert.equal(notifyCalls.length, 1, "the admin is pinged about the opened order");
});

test("submit: an xdevice invoice derives the xdevice product; a chain absent from the snapshot is refused", async () => {
  seedInvoice({
    id: "inv_x",
    userId: "u1",
    plan: "premium_xdevice",
    tier: 3,
    amountUsd: 29,
    methods: { btc: "BTC_AT_SEND", usdt_trc20: "TRC_AT_SEND", usdt_erc20: null },
  });
  session = { userId: "u1" };
  const { POST } = loadRoute(SUBMIT_ROUTE, submitDeps());

  const ok = await POST(req({ kind: "usdt_trc20", invoiceId: "inv_x" }));
  assert.equal(ok.status, 200);
  const payment = store.payments[0];
  assert.equal(payment.product, "xdevice", "tier-3 invoice ⇒ the xdevice consequence");
  assert.equal(payment.amountUsd, 29);
  assert.equal(payment.toAddress, "TRC_AT_SEND");

  const refused = await POST(req({ kind: "usdt_erc20", invoiceId: "inv_x" }));
  assert.equal(refused.status, 400);
  assert.match((refused.body as { error: string }).error, /not on this invoice/);
  assert.equal(store.payments.length, 1, "the refused attempt wrote nothing");
});

// ---------------------------------------------------------------------------
// THE CLAIM-THEN-GRANT CORE (settleLinkedInvoice + handleApprovedPayment)
// ---------------------------------------------------------------------------

test("settleLinkedInvoice: claim-once on a tier-5 invoice — one settle, one grant, re-settle refused", async () => {
  seedInvoice({ id: "inv_5", userId: "u1", tier: 5 });
  const ls = loadLicenseService();

  const first = await ls.settleLinkedInvoice({ id: "pay_x", userId: "u1", invoiceId: "inv_5" });
  assert.equal(first, true);
  const inv = store.invoices[0];
  assert.equal(inv.status, "paid");
  assert.ok(inv.paidAt instanceof Date, "a settled row carries paidAt");
  assert.deepEqual(
    grants,
    [{ fn: "grantPremium", userId: "u1", days: 30 }],
    "exactly one 30-day Premium term for a premium_plus invoice",
  );

  const again = await ls.settleLinkedInvoice({ id: "pay_y", userId: "u1", invoiceId: "inv_5" });
  assert.equal(again, false, "a second settle must find nothing open");
  assert.equal(grants.length, 1, "re-approve grants NOTHING");
});

test("settleLinkedInvoice: a tier-3 invoice grants the XDevice term, never the web premium", async () => {
  seedInvoice({ id: "inv_3", userId: "u1", plan: "premium_xdevice", tier: 3, amountUsd: 29 });
  const ls = loadLicenseService();
  const ok = await ls.settleLinkedInvoice({ id: "pay_x", userId: "u1", invoiceId: "inv_3" });
  assert.equal(ok, true);
  assert.deepEqual(grants, [{ fn: "grantXDeviceTerm", userId: "u1", days: 30 }]);
  assert.equal(store.invoices[0].status, "paid");
});

test("settleLinkedInvoice: a forged ref settles nothing (wrong owner / missing / already paid / no ref)", async () => {
  seedInvoice({ id: "inv_open", userId: "u1" });
  seedInvoice({ id: "inv_paid", userId: "u1", status: "paid", paidAt: new Date() });
  const ls = loadLicenseService();

  assert.equal(
    await ls.settleLinkedInvoice({ id: "p1", userId: "u2", invoiceId: "inv_open" }),
    false,
    "ownership is defense-in-depth even though submit checked it too",
  );
  assert.equal(await ls.settleLinkedInvoice({ id: "p2", userId: "u1", invoiceId: "inv_ghost" }), false);
  assert.equal(await ls.settleLinkedInvoice({ id: "p3", userId: "u1", invoiceId: "inv_paid" }), false);
  assert.equal(await ls.settleLinkedInvoice({ id: "p4", userId: "u1", invoiceId: null }), false);

  assert.equal(store.invoices[0].status, "open", "the forged ref left the invoice OPEN");
  assert.equal(grants.length, 0, "no grant left any refused path");
});

test("settleLinkedInvoice: losing the claim race grants NOTHING (claim-THEN-grant)", async () => {
  seedInvoice({ id: "inv_r", userId: "u1" });
  store.loseClaimRace = true; // a parallel approval claimed it between read and updateMany
  const ls = loadLicenseService();

  const ok = await ls.settleLinkedInvoice({ id: "p1", userId: "u1", invoiceId: "inv_r" });
  assert.equal(ok, false, "count 0 ⇒ lost the race ⇒ false, caller runs its default consequence");
  assert.equal(grants.length, 0, "the grant must follow a SUCCESSFUL claim — never race ahead of it");
  assert.equal(store.invoices[0].status, "open", "the fake never applied the claim");
});

test("handleApprovedPayment: a settled invoice skips the product branch — exactly ONE grant", async () => {
  seedInvoice({ id: "inv_1", userId: "u1", tier: 5 });
  seedPayment({
    id: "pay_1",
    userId: "u1",
    product: "web_subscription",
    status: "approved",
    invoiceId: "inv_1",
  });
  const ls = loadLicenseService();

  await ls.handleApprovedPayment("pay_1");
  assert.equal(store.invoices[0].status, "paid");
  assert.deepEqual(
    grants,
    [{ fn: "grantPremium", userId: "u1", days: 30 }],
    "settle granted once; had bumpWebTier ALSO run, this array would hold TWO rows (stacked term)",
  );
});

test("handleApprovedPayment: recovery — an already-settled invoice falls through to the product arm", async () => {
  seedInvoice({ id: "inv_done", userId: "u1", tier: 5, status: "paid", paidAt: new Date() });
  seedPayment({
    id: "pay_2",
    userId: "u1",
    product: "web_subscription",
    status: "approved",
    invoiceId: "inv_done",
  });
  const ls = loadLicenseService();

  await ls.handleApprovedPayment("pay_2");
  assert.deepEqual(
    grants,
    [{ fn: "grantPremium", userId: "u1", days: 30 }],
    "settle refused (already paid) ⇒ the normal product consequence IS the retry path, once",
  );
  assert.equal(store.invoices[0].status, "paid", "the settled evidence is untouched");
});

test("handleApprovedPayment: a non-approved payment (or a missing one) is never finalized", async () => {
  seedInvoice({ id: "inv_p", userId: "u1" });
  seedPayment({
    id: "pay_p",
    userId: "u1",
    product: "web_subscription",
    status: "pending",
    invoiceId: "inv_p",
  });
  const ls = loadLicenseService();

  await ls.handleApprovedPayment("pay_p");
  await ls.handleApprovedPayment("pay_ghost");
  assert.equal(grants.length, 0, "approval is the precondition for every consequence");
  assert.equal(store.invoices[0].status, "open");
});

// ---------------------------------------------------------------------------
// B4 — THE APPROVE ROUTE (one payment, one consequence — wallet never inverted)
// ---------------------------------------------------------------------------

test("approve: guards — non-admin 403, missing 404, already-finalized 400", async () => {
  seedPayment({ id: "pay_g", userId: "u1" });
  const ls = loadLicenseService();

  isAdmin = false;
  let route = loadRoute(APPROVE_ROUTE, approveDeps(ls, noWalletCredit));
  assert.equal((await route.POST(req({}), ctx({ id: "pay_g" }))).status, 403);

  isAdmin = true;
  route = loadRoute(APPROVE_ROUTE, approveDeps(ls, noWalletCredit));
  assert.equal((await route.POST(req({}), ctx({ id: "pay_ghost" }))).status, 404);

  store.payments[0].status = "approved";
  const again = await route.POST(req({}), ctx({ id: "pay_g" }));
  assert.equal(again.status, 400);
  assert.match((again.body as { error: string }).error, /already finalized/);
  assert.equal(grants.length, 0, "no guard path may reach a grant");
});

test("approve: an invoice payment on the top-up rail settles WITHOUT crediting the wallet", async () => {
  seedInvoice({ id: "inv_5", userId: "u1", tier: 5, amountUsd: 65 });
  seedPayment({
    id: "pay_top",
    userId: "u1",
    product: "wallet_topup",
    amountUsd: 65,
    status: "pending",
    invoiceId: "inv_5",
  });
  const ls = loadLicenseService();
  const route = loadRoute(APPROVE_ROUTE, approveDeps(ls, noWalletCredit));

  const res = await route.POST(req({}), ctx({ id: "pay_top" }));
  assert.equal(res.status, 200);
  const body = res.body as { ok: boolean; invoiceId?: string; creditedCents?: number };
  assert.equal(body.ok, true);
  assert.equal(body.invoiceId, "inv_5", "the response names the invoice that settled");
  assert.equal(store.invoices[0].status, "paid");
  assert.equal(store.payments[0].status, "approved");
  assert.deepEqual(
    grants,
    [{ fn: "grantPremium", userId: "u1", days: 30 }],
    "the invoice's own tier is granted",
  );
  assert.equal(
    creditCalls.length,
    0,
    "THE WALLET INVERSION: an invoice payment must never credit a balance",
  );
  assert.equal(body.creditedCents, undefined, "no balance in the response either");
  assert.equal(store.attempts.length, 1);
  assert.equal(store.attempts[0].note, "Premium invoice settled");
});

test("approve: a top-up whose invoice is already settled falls back to the wallet credit", async () => {
  seedInvoice({ id: "inv_paid", userId: "u1", status: "paid", paidAt: new Date() });
  seedPayment({
    id: "pay_t2",
    userId: "u1",
    product: "wallet_topup",
    amountUsd: 25,
    status: "pending",
    invoiceId: "inv_paid",
  });
  const ls = loadLicenseService();
  const route = loadRoute(APPROVE_ROUTE, approveDeps(ls, noWalletCredit));

  const res = await route.POST(req({}), ctx({ id: "pay_t2" }));
  assert.equal(res.status, 200);
  assert.equal(
    creditCalls.length,
    1,
    "settle refused ⇒ the row says top-up, so it credits (B4 fall-through)",
  );
  assert.equal(creditCalls[0].paymentId, "pay_t2");
  assert.equal(creditCalls[0].amountCents, 2500, "Math.ceil(25 * 100)");
  assert.equal((res.body as { creditedCents?: number }).creditedCents, 2500);
  assert.equal(store.payments[0].status, "approved");
  assert.equal(store.attempts[0].note, "Wallet top-up credited");
  assert.equal(grants.length, 0, "no invoice to settle ⇒ no grant");
});

test("approve: a plain top-up with no invoice ref still credits (B4 fall-through preserved)", async () => {
  seedPayment({ id: "pay_plain", userId: "u1", product: "wallet_topup", amountUsd: 25, status: "pending" });
  const ls = loadLicenseService();
  const route = loadRoute(APPROVE_ROUTE, approveDeps(ls, noWalletCredit));

  const res = await route.POST(req({}), ctx({ id: "pay_plain" }));
  assert.equal(res.status, 200);
  assert.equal(creditCalls.length, 1, "the pre-TASK_184 top-up behavior is untouched");
  assert.equal(store.payments[0].status, "approved");
  assert.equal(grants.length, 0);
});

test("approve: the product arm still routes through handleApprovedPayment (legacy path unchanged)", async () => {
  seedPayment({ id: "pay_leg", userId: "u1", product: "web_subscription", status: "pending" });
  let handled: string | null = null;
  const route = loadRoute(
    APPROVE_ROUTE,
    approveDeps(
      {
        handleApprovedPayment: async (id: string) => {
          handled = id;
        },
        settleLinkedInvoice: async () => false,
      },
      noWalletCredit,
    ),
  );

  const res = await route.POST(req({}), ctx({ id: "pay_leg" }));
  assert.equal(res.status, 200);
  assert.equal(handled, "pay_leg", "the shared handler owns every product consequence");
  assert.equal(creditCalls.length, 0, "a subscription is not a wallet credit");
  assert.equal(store.payments[0].status, "approved");
});

// ---------------------------------------------------------------------------
// THE WHOLE FLOW, ONE TEST — create → pay → approve → granted, double-click dead
// ---------------------------------------------------------------------------

test("lifecycle: create → pay → approve grants the invoice's tier exactly once; second approve refused", async () => {
  const ls = loadLicenseService();

  // 1. admin sends the invoice (amount edited to 65)
  const create = loadRoute(CREATE_ROUTE, adminInvoiceDeps());
  const created = await create.POST(
    req({ plan: "premium_plus", amountUsd: 65 }),
    ctx({ id: "u1" }),
  );
  assert.equal(created.status, 201);
  const invoiceId = (created.body as { invoice: InvoiceRow }).invoice.id;

  // 2. the owner pays it through the normal submit rail
  session = { userId: "u1" };
  const submit = loadRoute(SUBMIT_ROUTE, submitDeps());
  const paid = await submit.POST(req({ kind: "btc", invoiceId }));
  assert.equal(paid.status, 200);
  const paymentId = (paid.body as { paymentId: string }).paymentId;
  assert.equal(store.payments[0].amountUsd, 65, "the edited amount rides the payment");

  // 3. admin approves — REAL license-service, wallet shim is a recorder only
  const approve = loadRoute(APPROVE_ROUTE, approveDeps(ls, noWalletCredit));
  const res = await approve.POST(req({}), ctx({ id: paymentId }));
  assert.equal(res.status, 200);
  assert.equal(store.invoices.find((i) => i.id === invoiceId)?.status, "paid");
  assert.deepEqual(
    grants,
    [{ fn: "grantPremium", userId: "u1", days: 30 }],
    "ONE payment, ONE grant — claim-then-grant in the real route wiring",
  );
  assert.equal(creditCalls.length, 0, "a subscription approval never touches the wallet");

  // 4. a second approval click dies at the guard, before any consequence
  const again = await approve.POST(req({}), ctx({ id: paymentId }));
  assert.equal(again.status, 400);
  assert.equal(grants.length, 1, "the double-approval guard holds");
});








