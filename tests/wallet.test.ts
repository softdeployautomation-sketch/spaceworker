import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ---------------------------------------------------------------------------
// TASK_158 W1 — the wallet's contracts.
//
// THE FAILURE THIS SUITE EXISTS TO PREVENT: a customer's balance stops matching
// the sum of their own ledger, and nobody notices until a chargeback. Every test
// below asserts an INVARIANT, not a return value:
//
//   * the balance and the ledger row are written together, or neither is;
//   * the ledger's amountCents sums to the balance (modulo a zero starting row);
//   * a debit can never take the balance below the postpaid line, by even a cent;
//   * one payment credits one wallet exactly once, no matter how often it replays.
//
// WHY THE FAKE IMPLEMENTS THE CAS HONESTLY. `move()` survives concurrency by
// putting the value it read into the `where` of its own update and checking
// `count === 0`. A fake that ignored the `where` would make every one of those
// tests pass while the real code raced — so this fake REJECTS a stale write, and
// the concurrency test below runs two real `debitPurchase` calls against it via
// Promise.all. That is the whole design under test, and it costs nothing to fake.
//
// A real Postgres replay of the schema's own constraints (UNIQUE paymentId, the
// exactly-one-provenance CHECK) lives in scripts/replay-wallet-migration.sh. This
// suite covers the SERVICE; that script covers the DATABASE.
// ---------------------------------------------------------------------------

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@127.0.0.1:5432/test";

interface FakeUser {
  id: string;
  balanceCents: number;
  postpaidLimitCents: number;
}

interface FakeEntry {
  id: string;
  userId: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  note: string | null;
  postpaidLimitAfterCents: number | null;
  paymentId: string | null;
  adminId: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

interface FakePayment {
  id: string;
  userId: string;
  status: string;
  /** In dollars, like the real column. */
  amountUsd: number;
  creditedCents: number | null;
  adminNote: string | null;
}

const store: {
  users: FakeUser[];
  entries: FakeEntry[];
  payments: FakePayment[];
} = { users: [], entries: [], payments: [] };

/** Every write, in order, so a test can prove NOTHING was written on a refusal. */
let writes: Array<{ op: string; data: Record<string, unknown> }> = [];
/** Every WHERE the balance CAS carried — the proof the guard is really there. */
let casGuards: Array<Record<string, unknown>> = [];

const clock = new Date("2026-10-05T12:00:00.000Z");
let seq = 0;
const nextId = (p: string) => `${p}_${++seq}`;

/** Prisma's unique-violation, in the exact shape the service recognises. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

/**
 * The CAS. `count === 0` when the row moved since the caller read it — this is the
 * behaviour the whole design rests on, so it is implemented, not assumed.
 */
function casUpdate(
  userId: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): { count: number } {
  casGuards.push({ op: "user.updateMany", where });
  const u = store.users.find((x) => x.id === userId);
  if (!u) return { count: 0 };
  // EVERY key in the where must still hold. `{ id, balanceCents: 500 }` fails once
  // the row is at 400 — which is exactly the signal `move()` retries on.
  for (const [k, v] of Object.entries(where)) {
    if ((u as unknown as Record<string, unknown>)[k] !== v) return { count: 0 };
  }
  for (const [k, v] of Object.entries(data)) {
    (u as unknown as Record<string, unknown>)[k] = v;
  }
  return { count: 1 };
}

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const u = store.users.find((x) => x.id === where.id);
      return u ? { ...u } : null;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => casUpdate(String(where.id), where, data),
  },
  payment: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const p = store.payments.find((x) => x.id === where.id);
      return p ? { ...p } : null;
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      writes.push({ op: "payment.update", data });
      const p = store.payments.find((x) => x.id === where.id);
      if (!p) throw new Error("fake prisma: payment not found");
      for (const [k, v] of Object.entries(data)) {
        if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
      }
      return { ...p };
    },
  },
  walletLedgerEntry: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      writes.push({ op: "walletLedgerEntry.create", data });
      // The DB's UNIQUE indexes, faked. The service relies on these firing rather
      // than on a pre-flight check, so they must be real here.
      const idem = data.idempotencyKey as string | null;
      if (idem && store.entries.some((e) => e.idempotencyKey === idem)) throw uniqueViolation();
      const pay = data.paymentId as string | null;
      if (pay && store.entries.some((e) => e.paymentId === pay)) throw uniqueViolation();
      const row: FakeEntry = {
        id: nextId("wl"),
        userId: data.userId as string,
        kind: data.kind as string,
        amountCents: data.amountCents as number,
        balanceAfterCents: data.balanceAfterCents as number,
        note: (data.note ?? null) as string | null,
        postpaidLimitAfterCents: (data.postpaidLimitAfterCents ?? null) as number | null,
        paymentId: pay,
        adminId: (data.adminId ?? null) as string | null,
        idempotencyKey: idem,
        createdAt: clock,
      };
      store.entries.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
      const e = store.entries.find((x) => x.idempotencyKey === where.idempotencyKey);
      return e ? { ...e } : null;
    },
    findMany: async ({
      where,
      take,
    }: {
      where?: { userId?: string; id?: { lt?: string } };
      take?: number;
    }) => {
      let rows = store.entries.filter((e) => e.userId === where?.userId);
      const cursor = where?.id?.lt;
      if (cursor) rows = rows.filter((e) => e.id < cursor);
      // Newest first, and the fake honours `take` because the service relies on
      // the over-fetch-by-one trick to know whether a next page exists.
      rows = rows.slice().sort((a, b) => b.id.localeCompare(a.id));
      return take === undefined ? rows : rows.slice(0, take).map((r) => ({ ...r }));
    },
  },
  /**
   * The CALLBACK form only, which is the only form `lib/wallet.ts` uses. It is not
   * `Promise.all` on purpose: real `$transaction` rolls back on throw, and that
   * rollback is what makes "the balance and the ledger row are written together"
   * true. Snapshot-and-restore on throw is the smallest faithful stand-in.
   *
   * `tx` is typed `unknown` rather than `typeof fakePrisma` because the fake
   * refers to itself here, which TypeScript cannot infer through; the cast on the
   * call is confined to this one line and the service is typechecked against the
   * REAL client, not against this stub.
   */
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const usersBefore = store.users.map((u) => ({ ...u }));
    const paymentsBefore = store.payments.map((p) => ({ ...p }));
    const entriesBefore = store.entries.length;
    const writesBefore = writes.length;
    try {
      return await fn(fakePrisma);
    } catch (e) {
      store.users = usersBefore;
      // `store.payments` is inside the snapshot deliberately: the payment's
      // `creditedCents` is written by the same transaction, so a rollback test that
      // did not restore it would let the fake report a half-applied credit that the
      // real database could never produce.
      store.payments = paymentsBefore;
      store.entries.length = entriesBefore;
      writes.length = writesBefore;
      throw e;
    }
  },
};

const loader = Module as unknown as {
  _load: (r: string, p: NodeModule | undefined, m: boolean) => unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request, parent, isMain) {
  const from = parent?.filename ?? "";
  if (from.endsWith("/lib/wallet.ts") && request === "@/lib/prisma") {
    return { prisma: fakePrisma };
  }
  // `server-only` throws by design when it is reached outside a React Server
  // Component — which is exactly what a plain `tsx --test` run is. Stubbing it
  // keeps the guard in lib/wallet.ts (it is worth keeping) without the test
  // needing a bundler.
  if (from.endsWith("/lib/wallet.ts") && request === "server-only") return {};
  return originalLoad.call(this, request, parent, isMain);
};

/* eslint-disable @typescript-eslint/no-require-imports */
const wallet = require("../lib/wallet") as typeof import("../lib/wallet");
/* eslint-enable @typescript-eslint/no-require-imports */

function seedUser(id: string, balanceCents = 0, postpaidLimitCents = 0): FakeUser {
  const u: FakeUser = { id, balanceCents, postpaidLimitCents };
  store.users.push(u);
  return u;
}

const balanceOf = (id: string) => store.users.find((u) => u.id === id)!.balanceCents;

/** THE INVARIANT. Nothing else in this suite may be taken on trust. */
function assertLedgerSumsToBalance(userId: string, openingBalance = 0): void {
  const sum = store.entries
    .filter((e) => e.userId === userId)
    .reduce((n, e) => n + e.amountCents, openingBalance);
  assert.equal(sum, balanceOf(userId), "ledger sum must equal the cached balance");
}

beforeEach(() => {
  store.users = [];
  store.entries = [];
  store.payments = [];
  writes = [];
  casGuards = [];
  seq = 0;
});

/* ========================================================================== */
test("a credit writes the ledger row and the balance together", async () => {
  seedUser("u1");
  const res = await wallet.creditTopup({ userId: "u1", amountCents: 2500, note: "card topup" });

  assert.equal(res.ok, true);
  assert.equal(balanceOf("u1"), 2500);
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0].kind, "topup");
  assert.equal(store.entries[0].amountCents, 2500);
  assert.equal(store.entries[0].balanceAfterCents, 2500);
  assertLedgerSumsToBalance("u1");
});

test("a credit carries the CAS guard the design depends on", async () => {
  seedUser("u1");
  await wallet.creditTopup({ userId: "u1", amountCents: 100 });
  assert.deepEqual(casGuards[0].where, { id: "u1", balanceCents: 0 });
});

test("a debit that would overdraw a PREPAID account is refused and writes nothing", async () => {
  seedUser("u1", 500);
  const res = await wallet.debitPurchase({ userId: "u1", amountCents: 501 });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 402);
  assert.equal(res.code, "insufficient_credit");
  // The whole point: no half-applied movement.
  assert.equal(writes.length, 0);
  assert.equal(balanceOf("u1"), 500);
  assert.equal(store.entries.length, 0);
});

test("a postpaid account may go negative, but only to its limit", async () => {
  seedUser("u1", 500, 2000);
  const res = await wallet.debitPurchase({ userId: "u1", amountCents: 2500 });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.balanceCents, -2000, "exactly the limit, not one cent past");
  assertLedgerSumsToBalance("u1", 500);
});

test("one cent past the postpaid limit is refused", async () => {
  seedUser("u1", 500, 2000);
  const res = await wallet.debitPurchase({ userId: "u1", amountCents: 2501 });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 402);
  assert.equal(writes.length, 0);
  assert.equal(balanceOf("u1"), 500);
});

test("THE DOUBLE-SPEND TEST: two simultaneous debits cannot both win", async () => {
  // $10 balance, two $8 purchases fired at once — exactly the double-click.
  seedUser("u1", 1000);

  const [a, b] = await Promise.all([
    wallet.debitPurchase({ userId: "u1", amountCents: 800 }),
    wallet.debitPurchase({ userId: "u1", amountCents: 800 }),
  ]);

  const winners = [a, b].filter((r) => r.ok).length;
  assert.equal(winners, 1, "exactly one purchase may succeed");
  assert.equal(balanceOf("u1"), 200, "the balance must reflect one $8 spend, not two");
  assert.equal(store.entries.length, 1, "the loser must not leave a ledger row");
  assertLedgerSumsToBalance("u1", 1000);
});

test("concurrent debits that BOTH fit still both land, and the ledger still sums", async () => {
  seedUser("u1", 1000, 5000);
  const [a, b] = await Promise.all([
    wallet.debitPurchase({ userId: "u1", amountCents: 300 }),
    wallet.debitPurchase({ userId: "u1", amountCents: 300 }),
  ]);

  assert.equal(a.ok, true, "the loser retries and succeeds against the new truth");
  assert.equal(b.ok, true);
  assert.equal(balanceOf("u1"), 400);
  assert.equal(store.entries.length, 2);
  assertLedgerSumsToBalance("u1", 1000);
});

test("an idempotency key replays the ORIGINAL movement instead of charging twice", async () => {
  seedUser("u1", 1000);
  const first = await wallet.debitPurchase({
    userId: "u1",
    amountCents: 400,
    idempotencyKey: "checkout:abc",
  });
  const second = await wallet.debitPurchase({
    userId: "u1",
    amountCents: 400,
    idempotencyKey: "checkout:abc",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(second.value.id, first.value.id, "the replay returns the first entry");
  assert.equal(balanceOf("u1"), 600, "charged once");
  assert.equal(store.entries.length, 1);
  assertLedgerSumsToBalance("u1", 1000);
});

test("an idempotency key belonging to ANOTHER user is a named refusal, not a silent credit", async () => {
  seedUser("u1", 1000);
  seedUser("u2", 1000);
  await wallet.creditTopup({ userId: "u2", amountCents: 500, idempotencyKey: "shared" });

  // u1 tries to reuse u2's key. It must NOT be handed back as u1's success.
  const res = await wallet.creditTopup({ userId: "u1", amountCents: 500, idempotencyKey: "shared" });

  assert.equal(res.ok, false, "the collision must surface as a loud failure, not a silent credit");
  if (res.ok) return;
  assert.equal(res.code, "idempotency_key_conflict");
  assert.equal(balanceOf("u1"), 1000);
  assert.equal(balanceOf("u2"), 1500, "u2's own movement is untouched");
});

test("an approved payment credits the PAYMENT'S owner, never a caller-supplied id", async () => {
  seedUser("owner");
  seedUser("attacker");
  store.payments.push({ id: "p1", userId: "owner", status: "approved", amountUsd: 50, creditedCents: null, adminNote: null });

  const res = await wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 5000 });

  assert.equal(res.ok, true);
  assert.equal(balanceOf("owner"), 5000);
  assert.equal(balanceOf("attacker"), 0, "no other account may be credited");
  assert.equal(store.entries[0].paymentId, "p1");
});

test("an unapproved payment cannot be spent as if it had cleared", async () => {
  seedUser("u1");
  store.payments.push({ id: "p1", userId: "u1", status: "pending", amountUsd: 50, creditedCents: null, adminNote: null });

  const res = await wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 5000 });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "payment_not_approved");
  assert.equal(balanceOf("u1"), 0);
  assert.equal(store.entries.length, 0);
});

test("a replayed payment webhook credits exactly once", async () => {
  seedUser("u1");
  store.payments.push({ id: "p1", userId: "u1", status: "approved", amountUsd: 50, creditedCents: null, adminNote: null });

  const [a, b] = await Promise.all([
    wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 5000 }),
    wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 5000 }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(balanceOf("u1"), 5000, "the UNIQUE paymentId index is the guard");
  assert.equal(store.entries.length, 1);
  assertLedgerSumsToBalance("u1");
});

test("an admin adjustment without a note is refused", async () => {
  seedUser("u1", 100);
  const res = await wallet.adminAdjustBalance({
    userId: "u1",
    amountCents: 500,
    adminId: "admin1",
    note: "   ",
  });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "note_required");
  assert.equal(writes.length, 0, "an unlabelled adjustment must never reach the ledger");
  assert.equal(balanceOf("u1"), 100);
});

test("an admin adjustment records who did it and why", async () => {
  seedUser("u1", 100);
  const res = await wallet.adminAdjustBalance({
    userId: "u1",
    amountCents: -50,
    adminId: "admin1",
    note: "goodwill for outage on the 4th",
  });

  assert.equal(res.ok, true);
  assert.equal(store.entries[0].kind, "admin_adjust");
  assert.equal(store.entries[0].adminId, "admin1");
  assert.equal(store.entries[0].note, "goodwill for outage on the 4th");
  assert.equal(balanceOf("u1"), 50);
  assertLedgerSumsToBalance("u1", 100);
});

test("granting a credit limit writes a zero-amount row, so the ledger still sums", async () => {
  seedUser("u1", 700);
  const res = await wallet.setPostpaidLimit({
    userId: "u1",
    limitCents: 5000,
    adminId: "admin1",
    note: "enterprise pilot",
  });

  assert.equal(res.ok, true);
  assert.equal(res.ok && res.value.postpaidLimitCents, 5000);
  assert.equal(store.entries[0].kind, "postpaid_grant");
  assert.equal(store.entries[0].amountCents, 0, "a ceiling is not money");
  assert.equal(store.entries[0].postpaidLimitAfterCents, 5000);
  assert.equal(balanceOf("u1"), 700, "granting credit must not move the balance");
  assertLedgerSumsToBalance("u1", 700);
});

test("lowering a credit limit is recorded as a revoke", async () => {
  seedUser("u1", 700, 5000);
  const res = await wallet.setPostpaidLimit({ userId: "u1", limitCents: 0, adminId: "admin1" });

  assert.equal(res.ok, true);
  assert.equal(store.entries[0].kind, "postpaid_revoke");
  assert.equal(store.entries[0].amountCents, 0);
  assert.equal(store.users[0].postpaidLimitCents, 0);
  assertLedgerSumsToBalance("u1", 700);
});

test("a negative credit limit is refused before it reaches the CHECK constraint", async () => {
  seedUser("u1", 700);
  const res = await wallet.setPostpaidLimit({ userId: "u1", limitCents: -1, adminId: "admin1" });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "invalid_amount");
  assert.equal(writes.length, 0);
  assert.equal(store.users[0].postpaidLimitCents, 0);
});

test("fractional and zero amounts are refused rather than rounded", async () => {
  seedUser("u1", 100);
  const frac = await wallet.creditTopup({ userId: "u1", amountCents: 12.5 });
  const zero = await wallet.creditTopup({ userId: "u1", amountCents: 0 });

  assert.equal(frac.ok, false);
  assert.equal(zero.ok, false);
  assert.equal(balanceOf("u1"), 100, "a rejected amount must not move a cent");
});

test("a negative 'credit' is refused at the public function, not smuggled in", async () => {
  seedUser("u1", 100);
  const res = await wallet.creditTopup({ userId: "u1", amountCents: -5000 });
  assert.equal(res.ok, false);
  assert.equal(balanceOf("u1"), 100);
});

test("an unknown kind cannot be invented by a caller", async () => {
  seedUser("u1", 100);
  const res = await wallet.move("u1", { kind: "free_money" as never, amountCents: 100 });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "unknown_wallet_kind");
  assert.equal(balanceOf("u1"), 100);
});

test("a wallet read reports what the user can actually spend", async () => {
  seedUser("prepaid", 300, 0);
  seedUser("postpaid", 300, 2500);

  const a = await wallet.getWallet("prepaid");
  const b = await wallet.getWallet("postpaid");
  assert.equal(a.ok && a.value.prepaidOnly, true);
  assert.equal(a.ok && a.value.spendableCents, 300);
  assert.equal(b.ok && b.value.prepaidOnly, false);
  assert.equal(b.ok && b.value.spendableCents, 2800);

  const afford = await wallet.canAfford("postpaid", 2801);
  assert.equal(afford.ok, true);
  assert.equal(afford.ok && afford.value, false);
});

test("a ledger page is newest first and pages by cursor without repeating a row", async () => {
  seedUser("u1", 1000);
  for (let i = 0; i < 5; i++) {
    await wallet.creditTopup({ userId: "u1", amountCents: 100 });
  }
  // u2's rows must never appear in u1's statement.
  seedUser("u2", 1000);
  await wallet.creditTopup({ userId: "u2", amountCents: 999 });

  const first = await wallet.listLedger("u1", { limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.entries.length, 2);
  assert.ok(first.value.nextCursor, "a partial page must advertise a cursor");

  const second = await wallet.listLedger("u1", { limit: 10, cursor: first.value.nextCursor });
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const ids = [...first.value.entries, ...second.value.entries].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "no row may appear on two pages");
  assert.equal(ids.length, 5);
  assert.equal(second.value.nextCursor, null, "the last page ends");
  assert.deepEqual(ids, [...ids].sort().reverse(), "entries must come back newest first");
});

test("a credit larger than the payment is refused", async () => {
  seedUser("u1");
  // Paid $50.00.
  store.payments.push({ id: "p1", userId: "u1", status: "approved", amountUsd: 50, creditedCents: null, adminNote: null });

  const res = await wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 5001 });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "credit_exceeds_payment");
  assert.equal(balanceOf("u1"), 0, "a $50.01 credit on a $50 payment is not a rounding error");
  assert.equal(store.entries.length, 0);
});

test("a payment already credited in full cannot be credited again", async () => {
  seedUser("u1");
  store.payments.push({ id: "p1", userId: "u1", status: "approved", amountUsd: 50, creditedCents: 5000, adminNote: null });

  const res = await wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 100 });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "credit_exceeds_payment");
  assert.equal(balanceOf("u1"), 0);
});

test("a PARTIAL credit is allowed, and only the remainder is left", async () => {
  seedUser("u1");
  store.payments.push({ id: "p1", userId: "u1", status: "approved", amountUsd: 50, creditedCents: 3000, adminNote: null });

  // $20 of the $50 invoice is left.
  const okRes = await wallet.creditApprovedPayment({ paymentId: "p1", amountCents: 2000 });
  assert.equal(okRes.ok, true);
  assert.equal(balanceOf("u1"), 2000);
  assert.equal(store.payments[0].creditedCents, 5000, "$30 already + $20 now = $50");

  // A DIFFERENT payment, invoiced for a single cent, may be credited for a single
  // cent — `Math.ceil(0.001 * 100)` is 1, not 0, which is the deliberate
  // round-in-the-customer's-favour choice. One cent more than that is refused,
  // which also proves the bound is read per-payment rather than being some global
  // already-credited flag left over from p1.
  store.payments.push({ id: "p2", userId: "u1", status: "approved", amountUsd: 0.001, creditedCents: null, adminNote: null });
  const exact = await wallet.creditApprovedPayment({ paymentId: "p2", amountCents: 1 });
  assert.equal(exact.ok, true);
  assert.equal(balanceOf("u1"), 2001);

  store.payments.push({ id: "p3", userId: "u1", status: "approved", amountUsd: 0.001, creditedCents: null, adminNote: null });
  const overRes = await wallet.creditApprovedPayment({ paymentId: "p3", amountCents: 2 });
  assert.equal(overRes.ok, false);
  if (!overRes.ok) assert.equal(overRes.code, "credit_exceeds_payment");
  assert.equal(balanceOf("u1"), 2001);
});

test("the payment's creditedCents is written IN THE SAME TRANSACTION as the balance", async () => {
  seedUser("u1");
  store.payments.push({ id: "p1", userId: "u1", status: "approved", amountUsd: 50, creditedCents: null, adminNote: null });

  const res = await wallet.creditApprovedPayment({
    paymentId: "p1",
    amountCents: 5000,
    adminNote: "converted from the annual plan",
  });

  assert.equal(res.ok, true);
  assert.equal(store.payments[0].creditedCents, 5000, "the invoice must record what the wallet was told");
  assert.equal(store.payments[0].adminNote, "converted from the annual plan");
  // The ordering is the guarantee: the payment cannot be updated unless the
  // balance CAS already won, so the two can never disagree in the other direction
  // either — a creditedCents with no money in the wallet is not reachable.
  const ops = writes.map((w) => w.op);
  assert.equal(ops[0], "payment.update");
  assert.ok(ops.includes("walletLedgerEntry.create"));
});

test("a failure AFTER the payment is touched rolls the whole credit back", async () => {
  seedUser("u1", 1000);
  seedUser("u2");
  store.payments.push({ id: "p1", userId: "u1", status: "approved", amountUsd: 50, creditedCents: null, adminNote: null });
  // u2 already owns this key, so the ledger insert will raise a unique violation —
  // AFTER the CAS has moved u1's balance and the payment has been updated.
  await wallet.creditTopup({ userId: "u2", amountCents: 100, idempotencyKey: "clash" });

  const res = await wallet.creditApprovedPayment({
    paymentId: "p1",
    amountCents: 5000,
    idempotencyKey: "clash",
  });

  assert.equal(res.ok, false);
  // Every intermediate effect must be gone. A partial rollback here would leave
  // u1's balance short AND the payment claiming it was credited — the customer
  // would be charged twice over for one purchase.
  assert.equal(balanceOf("u1"), 1000, "the balance CAS must be rolled back");
  assert.equal(store.payments[0].creditedCents, null, "creditedCents must be rolled back");
  assert.equal(store.payments[0].adminNote, null);
  assert.equal(
    store.entries.filter((e) => e.paymentId === "p1").length,
    0,
    "no ledger row may survive"
  );
  assertLedgerSumsToBalance("u1", 1000);
  assertLedgerSumsToBalance("u2");
});

test("an unknown account is a 404, not a silent zero balance", async () => {
  const res = await wallet.getWallet("nobody");
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
});

/* ========================================================================== */
/* PLAN_TASK_167 W3 — the admin grant (grantBalance).                          */
/* ========================================================================== */

test("a grant credits the balance and names the admin who gave it", async () => {
  seedUser("u1", 100);
  const res = await wallet.grantBalance({
    userId: "u1",
    amountCents: 2500,
    adminId: "admin1",
    note: "paid for the Pro upgrade by bank transfer",
  });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.kind, "admin_grant", "a positive grant is a grant, not an adjustment");
  assert.equal(res.value.amountCents, 2500);
  assert.equal(balanceOf("u1"), 2600);
  assert.equal(store.entries[0].adminId, "admin1", "an unattributed balance change is a support incident");
  assert.equal(store.entries[0].note, "paid for the Pro upgrade by bank transfer");
  assert.equal(res.value.replayed, undefined, "a first grant is not a replay");
  assertLedgerSumsToBalance("u1", 100);
});

test("a NEGATIVE grant is filed as admin_adjust, never as admin_grant", async () => {
  seedUser("u1", 1000);
  const res = await wallet.grantBalance({
    userId: "u1",
    amountCents: -300,
    adminId: "admin1",
    note: "clawed back a duplicated grant",
  });

  assert.equal(res.ok, true);
  if (!res.ok) return;
  // §3.4: two ledger kinds, two different meanings in the UI. A negative grant
  // dressed as admin_grant would make "we gave you money" and "we took money back"
  // indistinguishable on the statement.
  assert.equal(res.value.kind, "admin_adjust");
  assert.equal(res.value.amountCents, -300);
  assert.equal(balanceOf("u1"), 700);
  assertLedgerSumsToBalance("u1", 1000);
});

test("a grant without a note is refused and writes nothing", async () => {
  seedUser("u1", 100);
  const res = await wallet.grantBalance({
    userId: "u1",
    amountCents: 500,
    adminId: "admin1",
    note: "   ",
  });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "note_required");
  assert.equal(writes.length, 0, "an unlabelled grant must never reach the ledger");
  assert.equal(balanceOf("u1"), 100);
});

test("a zero grant is refused", async () => {
  seedUser("u1", 100);
  const res = await wallet.grantBalance({ userId: "u1", amountCents: 0, adminId: "a1", note: "nothing" });

  assert.equal(res.ok, false);
  assert.equal(writes.length, 0);
  assert.equal(balanceOf("u1"), 100);
});

test("a fractional amount never reaches the ledger — no float touches money", async () => {
  seedUser("u1");
  const res = await wallet.grantBalance({ userId: "u1", amountCents: 1050.5, adminId: "a1", note: "typo" });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "invalid_amount");
  assert.equal(writes.length, 0);
  assert.equal(balanceOf("u1"), 0);
});

test("a replayed grant key credits ONCE and is reported as a replay", async () => {
  seedUser("u1");
  const first = await wallet.grantBalance({
    userId: "u1",
    amountCents: 1000,
    adminId: "admin1",
    note: "goodwill",
    idempotencyKey: "grant-1",
  });
  const second = await wallet.grantBalance({
    userId: "u1",
    amountCents: 1000,
    adminId: "admin1",
    note: "goodwill",
    idempotencyKey: "grant-1",
  });

  assert.equal(first.ok && first.value.replayed, undefined);
  assert.equal(second.ok, true, "the index refuses the duplicate without erroring");
  if (!second.ok) return;
  // The flag is what lets the route answer 409 for a double-clicked Save while the
  // UNIQUE index remains the actual guard — no check-then-act anywhere.
  assert.equal(second.value.replayed, true);
  assert.equal(second.value.id, first.ok ? first.value.id : "", "the replay names the original entry");
  assert.equal(balanceOf("u1"), 1000, "credited exactly once");
  assert.equal(store.entries.length, 1);
  assertLedgerSumsToBalance("u1");
});

test("two grants fired at the same moment still credit once", async () => {
  seedUser("u1");
  await Promise.all([
    wallet.grantBalance({ userId: "u1", amountCents: 700, adminId: "a1", note: "x", idempotencyKey: "k" }),
    wallet.grantBalance({ userId: "u1", amountCents: 700, adminId: "a1", note: "x", idempotencyKey: "k" }),
  ]);

  assert.equal(balanceOf("u1"), 700);
  assert.equal(store.entries.length, 1);
  assertLedgerSumsToBalance("u1");
});

test("a grant key already used for ANOTHER user is a named refusal", async () => {
  seedUser("u1");
  seedUser("u2");
  await wallet.grantBalance({ userId: "u2", amountCents: 100, adminId: "a1", note: "n", idempotencyKey: "shared" });

  const res = await wallet.grantBalance({
    userId: "u1",
    amountCents: 100,
    adminId: "a1",
    note: "n",
    idempotencyKey: "shared",
  });

  assert.equal(res.ok, false, "never a silent cross-account success");
  if (res.ok) return;
  assert.equal(res.code, "idempotency_key_conflict");
  assert.equal(res.status, 409);
  assert.equal(balanceOf("u1"), 0);
  assert.equal(balanceOf("u2"), 100);
});

test("admin_grant is a real ledger kind, not a value move() would reject", async () => {
  seedUser("u1");
  const res = await wallet.grantBalance({ userId: "u1", amountCents: 1, adminId: "a1", note: "n" });

  // Guards the regression this kind actually had: `admin_grant` was documented in
  // the schema and in the comment above creditTopup, but absent from KINDS — so
  // move() answered 500 unknown_wallet_kind and no grant could ever be filed.
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.value.kind, "admin_grant");
});

test("a grant for an unknown account is a 404 and writes nothing", async () => {
  const res = await wallet.grantBalance({
    userId: "nobody",
    amountCents: 500,
    adminId: "admin1",
    note: "typo in the id",
  });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404);
  assert.equal(writes.length, 0);
});


test("a movement for an unknown account writes nothing", async () => {
  const res = await wallet.creditTopup({ userId: "nobody", amountCents: 100 });
  assert.equal(res.ok, false);
  assert.equal(writes.length, 0);
});