import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// TASK_158 W1 — the wallet service.
//
// THE ONLY MODULE allowed to move money. `User.balanceCents` may be written
// anywhere else in the codebase and it will be a bug; the ledger row and the
// balance are only ever correct together because this file writes both inside one
// transaction.
//
// THE RACE THIS FILE IS BUILT AROUND. Two simultaneous purchases from one account
// are not a hypothetical — a user with $5 and a $5 item who double-clicks, or two
// of their own tabs, is the normal case. Read-balance / check / write-balance is
// the shape of that bug: both callers read 500, both see "enough", both write 0,
// and the customer has bought two things for the price of one. So the balance
// write is a COMPARE-AND-SWAP on the balance value itself
// (`updateMany where balanceCents = <what I read>`): the loser gets `count === 0`
// and retries against the new truth. That is the same idiom lib/job-resume.ts
// uses to stop two dispatchers claiming one job, and it needs no raw SQL, no
// table lock and no advisory lock to survive.
//
// WHY NOT `SELECT … FOR UPDATE`. It would work, but it needs raw SQL and a
// transaction wrapper at every call site, and the failure mode of forgetting the
// wrapper is a silent double-spend. A guard that is part of the write itself
// cannot be forgotten.
//
// EVERY FUNCTION RETURNS a `WalletResult` rather than throwing, matching the
// `SupportResult` / `HostingResult` convention, so a route is one `.ok` branch.
// ---------------------------------------------------------------------------

export type WalletResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

/**
 * The complete set of reasons a wallet row can exist. A `string` column and not a
 * Postgres enum (see the schema comment), which means THIS list is the only thing
 * standing between a typo and a statement that can no longer explain itself — so
 * it is checked at runtime by `move()`, not merely documented.
 */
export type WalletEntryKind =
  | "topup"
  | "purchase_credit"
  | "admin_adjust"
  | "admin_grant"
  | "debit_purchase"
  | "refund"
  | "postpaid_grant"
  | "postpaid_revoke";

const KINDS: readonly WalletEntryKind[] = [
  "topup",
  "purchase_credit",
  "admin_adjust",
  "admin_grant",
  "debit_purchase",
  "refund",
  "postpaid_grant",
  "postpaid_revoke",
];

/**
 * How many times a compare-and-swap may lose before we give up. Three concurrent
 * debits on one account will make two of them retry; an account under that much
 * simultaneous pressure is already a support ticket, and spinning forever would
 * turn a fast 409 into a hung request.
 */
const MAX_CAS_ATTEMPTS = 5;

/** A note is bounded so "just one more thing" cannot become a megabyte per row. */
const MAX_NOTE_LEN = 500;

/** Prisma's unique-violation code, matched as a string to keep this file import-free. */
const UNIQUE_VIOLATION = "P2002";

export interface WalletView {
  /** Cached total, in cents. The authoritative sum is the ledger's. */
  balanceCents: number;
  /** How far below zero this user may go. 0 = prepaid only. */
  postpaidLimitCents: number;
  /**
   * The most this user can spend right now. Negative when the balance is already
   * below zero and there is no remaining line — a caller that needs it can compare
   * a price against this without re-deriving the rule.
   */
  spendableCents: number;
  /** True when the user must pay in advance, i.e. the current behaviour. */
  prepaidOnly: boolean;
}

export interface WalletEntryView {
  id: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  note: string | null;
  postpaidLimitAfterCents: number | null;
  createdAt: string;
}

/** What a caller asks the wallet to do. One shape for every movement. */
interface Movement {
  kind: WalletEntryKind;
  amountCents: number;
  note?: string;
  /**
   * Set for a credit that came from a real payment. It is the DB's UNIQUE index
   * that makes "credit a payment twice" impossible, not a pre-flight check — a
   * replayed webhook is exactly the race a read-then-write would lose.
   */
  paymentId?: string;
  /** Required for the admin kinds, and meaningless elsewhere. */
  adminId?: string;
  /** A caller-supplied repeat guard (e.g. `checkout:<id>`). UNIQUE when present. */
  idempotencyKey?: string;
  /**
   * True for a debit: may take the balance below zero, but never below the
   * postpaid limit. False (the default) means the result must stay at or above
   * zero — which is what every credit, and every refund, must do.
   */
  allowOverdraw?: boolean;
  /**
   * Runs INSIDE the movement's transaction, after the balance CAS has won and
   * before the ledger row is written. This exists so a movement and the record
   * that explains it are committed or rolled back together — the payment row's
   * `creditedCents` is the case: setting it in a second statement would leave a
   * window where the wallet holds the money and the payment says it was not
   * credited, which is precisely the question a refund dispute turns on.
   *
   * It is handed Prisma's TRANSACTION client, not the global one, so a hook
   * physically cannot escape the transaction it was given.
   */
  alsoWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/** The subset of a ledger row this file reads or returns. */
type EntryRow = {
  id: string;
  userId: string;
  kind: string;
  amountCents: number;
  balanceAfterCents: number;
  note: string | null;
  postpaidLimitAfterCents: number | null;
  createdAt: Date;
};

/** A completed movement: the ledger entry, plus the balance it produced. */
export type WalletMovement = WalletEntryView & { balanceCents: number } & {
  /**
   * True when this result came from an idempotency key that had ALREADY produced
   * a movement, rather than from a fresh one.
   *
   * WHY THIS IS NOT GUESSABLE BY THE CALLER. The DB's UNIQUE index is the real
   * guard, and it fires as a throw that `move()` catches and converts into "here
   * is the original entry, you already did this" — which is the correct answer for
   * a webhook that may legitimately be retried. But an admin form is not a
   * webhook: the admin's intent is "apply this grant once", and a second
   * identical success is indistinguishable, from the outside, from two real grants
   * having landed. That is precisely the ambiguity a money endpoint must not hand
   * back to its caller, so it is surfaced here as data instead. A route can then
   * answer 409 while the guard itself stays the index — rather than the route
   * resorting to a check-then-act read, which is the race this whole file exists
   * to avoid.
   *
   * Absent (false) on every genuinely fresh movement.
   */
  replayed?: boolean;
};

function notFound(): WalletResult<never> {
  return { ok: false, status: 404, code: "user_not_found", message: "Account not found." };
}

function badAmount(message: string): WalletResult<never> {
  return { ok: false, status: 422, code: "invalid_amount", message };
}

/**
 * Money is cents, and an amount is validated here ONCE so no caller can invent its
 * own rules:
 *   * it must be an integer — `12.5` cents is not half a cent, it is a bug, and
 *     rounding it silently is how a balance stops being the sum of its ledger;
 *   * it must be non-zero — a zero row is a note wearing a money row's clothes.
 * The SIGN is not constrained here, because a credit and a debit are the same
 * operation and the caller decides which by naming the `kind`.
 */
function checkAmount(amountCents: number): WalletResult<number> {
  if (!Number.isInteger(amountCents)) return badAmount("Amounts are in whole cents.");
  if (amountCents === 0) return badAmount("That amount is zero, so there is nothing to record.");
  return { ok: true, value: amountCents };
}

function checkNote(note: string | undefined): WalletResult<string | undefined> {
  if (note === undefined) return { ok: true, value: undefined };
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE_LEN) {
    return {
      ok: false,
      status: 422,
      code: "note_too_long",
      message: `Keep the note under ${MAX_NOTE_LEN} characters.`,
    };
  }
  return { ok: true, value: trimmed === "" ? undefined : trimmed };
}

function toEntryView(row: EntryRow): WalletEntryView {
  return {
    id: row.id,
    kind: row.kind,
    amountCents: row.amountCents,
    balanceAfterCents: row.balanceAfterCents,
    note: row.note,
    postpaidLimitAfterCents: row.postpaidLimitAfterCents,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Cents as money, for the one place a human reads a number. */
export function formatCents(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * The unique-violation error Prisma raises when `idempotencyKey` (or `paymentId`)
 * already exists. Matched by its code rather than by importing the error classes,
 * because this file is imported by unit tests that stub Prisma entirely, and a
 * runtime `instanceof` against the real client would not survive that.
 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * The entry an `idempotencyKey` already produced, or null.
 *
 * Scoped to `userId` on purpose: the key is caller-supplied, so a bug (or an
 * attack) that reuses another customer's key must NOT come back as this user's
 * successful movement. Falling through to "no prior" means the real, loud failure
 * is reported instead.
 */
async function findPrior(idempotencyKey: string, userId: string): Promise<WalletMovement | null> {
  const prior = await prisma.walletLedgerEntry.findUnique({ where: { idempotencyKey } });
  if (!prior || prior.userId !== userId) return null;
  return { ...toEntryView(prior), balanceCents: prior.balanceAfterCents };
}
/**
 * THE ONE FUNCTION THAT MOVES MONEY. Everything else in this file is validation
 * in front of a call to this.
 *
 * Returns the new balance and the ledger row it wrote. On a lost compare-and-swap
 * it silently re-reads and tries again; the caller never sees a contention error
 * unless MAX_CAS_ATTEMPTS genuinely all lose.
 */
export async function move(userId: string, m: Movement): Promise<WalletResult<WalletMovement>> {
  if (!KINDS.includes(m.kind)) {
    return {
      ok: false,
      status: 500,
      code: "unknown_wallet_kind",
      message: "That wallet entry kind does not exist.",
    };
  }
  const amount = checkAmount(m.amountCents);
  if (!amount.ok) return amount;
  const note = checkNote(m.note);
  if (!note.ok) return note;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, balanceCents: true, postpaidLimitCents: true },
    });
    if (!user) return notFound();

    const next = user.balanceCents + amount.value;
    // The floor. A credit can never breach it; a debit may go negative only as far
    // as the postpaid line allows, and no further.
    if (next < -user.postpaidLimitCents) {
      const short = -next - user.postpaidLimitCents;
      return {
        ok: false,
        status: 402,
        code: "insufficient_credit",
        message:
          m.allowOverdraw === true && user.postpaidLimitCents > 0
            ? `That is ${formatCents(short)} more than your balance and credit line.`
            : `That is ${formatCents(short)} more than your balance. Add funds or lower the amount.`,
      };
    }

    let written: EntryRow | null = null;
    try {
      written = await prisma.$transaction(async (tx) => {
        // THE COMPARE-AND-SWAP. `balanceCents: user.balanceCents` in the `where`
        // is the whole concurrency story: if anyone moved this balance since the
        // read above, this matches zero rows and the whole transaction — including
        // the ledger row — is rolled back. Losing the race is therefore free and
        // leaves no partial money trail.
        const { count } = await tx.user.updateMany({
          where: { id: userId, balanceCents: user.balanceCents },
          data: { balanceCents: next },
        });
        if (count === 0) return null;
        // The caller's own record-keeping, inside the same transaction. After the
        // CAS has won (there is nothing to record if it lost) and before the
        // ledger row, so a throw here rolls the whole movement back.
        await m.alsoWrite?.(tx as unknown as Prisma.TransactionClient);
        return tx.walletLedgerEntry.create({
          data: {
            userId,
            kind: m.kind,
            amountCents: amount.value,
            balanceAfterCents: next,
            postpaidLimitAfterCents: user.postpaidLimitCents,
            note: note.value ?? null,
            paymentId: m.paymentId ?? null,
            adminId: m.adminId ?? null,
            idempotencyKey: m.idempotencyKey ?? null,
          },
        });
      });
    } catch (e) {
      // The DB's UNIQUE index is the real idempotency guard, and it fires as a
      // throw rather than as a count. A replayed payment or a retried checkout
      // lands here and must be reported as the ORIGINAL success, not as an error
      // the caller will retry into a third movement.
      //
      // The `isUniqueViolation` test is load-bearing, not tidiness: without it a
      // genuine failure (the database down, a CHECK violation) that happened to
      // occur while a matching key existed would be reported as a paid invoice.
      if (isUniqueViolation(e) && m.idempotencyKey) {
        const prior = await findPrior(m.idempotencyKey, userId);
        // `replayed: true` is load-bearing for callers that must distinguish "this
        // just happened" from "this already happened" — see `WalletMovement`.
        if (prior) return { ok: true, value: { ...prior, replayed: true } };
        // The key exists but belongs to SOMEONE ELSE. This is the cross-account
        // collision `findPrior` refuses to paper over, and it is a caller bug — so
        // it becomes a NAMED refusal instead of an exception escaping a module
        // whose whole contract is that it returns rather than throws. A route can
        // now log this as a real fault; an unhandled P2002 would only ever surface
        // as a 500 with an opaque message.
        return {
          ok: false,
          status: 409,
          code: "idempotency_key_conflict",
          message: "That reference has already been used for a different movement.",
        };
      }
      if (isUniqueViolation(e) && m.paymentId) {
        // A payment already credited a wallet through a path that carried no
        // idempotency key. Same reasoning: a name, not an exception.
        return {
          ok: false,
          status: 409,
          code: "payment_already_credited",
          message: "That payment has already been credited to a wallet.",
        };
      }
      throw e;
    }

    if (written) return { ok: true, value: { ...toEntryView(written), balanceCents: next } };

    // We lost the CAS. Before retrying, honour an idempotent replay: a caller that
    // retried a request which actually SUCCEEDED the first time must get the
    // original result back, not a second debit.
    if (m.idempotencyKey) {
      const prior = await findPrior(m.idempotencyKey, userId);
      if (prior) return { ok: true, value: prior };
    }
  }

  return {
    ok: false,
    status: 409,
    code: "wallet_contended",
    message: "Your balance was changing at the same time. Please try again.",
  };
}
// ---------------------------------------------------------------------------
// The public surface. Each of these is validation in front of `move()` — none of
// them touches Prisma directly, which is what keeps "one code path moves money"
// true rather than aspirational.
// ---------------------------------------------------------------------------

/** Read one wallet. The user's OWN id only; there is no admin read path here. */
export async function getWallet(userId: string): Promise<WalletResult<WalletView>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, balanceCents: true, postpaidLimitCents: true },
  });
  if (!user) return notFound();
  return {
    ok: true,
    value: {
      balanceCents: user.balanceCents,
      postpaidLimitCents: user.postpaidLimitCents,
      // balance + remaining line. This is the same arithmetic `move()` uses for
      // its floor, so a caller can pre-check a price with it and be right.
      spendableCents: user.balanceCents + user.postpaidLimitCents,
      prepaidOnly: user.postpaidLimitCents === 0,
    },
  };
}

export interface ListLedgerOptions {
  /** How many entries. Default and maximum 100 — a statement is not a data dump. */
  limit?: number;
  /** Page back with the last entry's id. */
  cursor?: string | null;
}

export interface LedgerPage {
  entries: WalletEntryView[];
  /** Pass back as `cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

/**
 * One page of a user's ledger, NEWEST FIRST.
 *
 * Keyset pagination, not `skip`/`offset`: rows are appended forever, so an offset
 * would silently shift under a reader who is paging through a statement and show
 * them the same row twice, or skip one entirely.
 */
export async function listLedger(
  userId: string,
  opts: ListLedgerOptions = {}
): Promise<WalletResult<LedgerPage>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await prisma.walletLedgerEntry.findMany({
    where: { userId, ...(opts.cursor ? { id: { lt: opts.cursor } } : {}) },
    orderBy: { id: "desc" },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    ok: true,
    value: {
      entries: page.map(toEntryView),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    },
  };
}
/**
 * Add money to a wallet. The `kind` is the caller's claim about WHY, and only
 * three are reachable from here — a user cannot mint themselves an `admin_grant`.
 */
export async function creditTopup(input: {
  userId: string;
  amountCents: number;
  note?: string;
  paymentId?: string;
  idempotencyKey?: string;
  kind?: Extract<WalletEntryKind, "topup" | "purchase_credit" | "refund">;
}): Promise<WalletResult<WalletMovement>> {
  if (input.amountCents <= 0) return badAmount("A credit must be a positive amount.");
  return move(input.userId, {
    kind: input.kind ?? "topup",
    amountCents: input.amountCents,
    note: input.note,
    paymentId: input.paymentId,
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Spend money. The one place a purchase actually debits a wallet.
 *
 * `allowOverdraw` is set here and nowhere else, and the postpaid floor is enforced
 * by `move()` either way — which is the point: the rule lives in one place, so a
 * new caller cannot get it wrong by forgetting an argument.
 */
export async function debitPurchase(input: {
  userId: string;
  amountCents: number;
  note?: string;
  idempotencyKey?: string;
}): Promise<WalletResult<WalletMovement>> {
  if (input.amountCents <= 0) return badAmount("A purchase must be a positive amount.");
  return move(input.userId, {
    kind: "debit_purchase",
    amountCents: -input.amountCents,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
    allowOverdraw: true,
  });
}

/** Can this user afford `amountCents` right now? A pure read — never moves money. */
export async function canAfford(userId: string, amountCents: number): Promise<WalletResult<boolean>> {
  const w = await getWallet(userId);
  if (!w.ok) return w;
  return { ok: true, value: w.value.spendableCents >= amountCents };
}
/**
 * Credit an APPROVED payment into its owner's wallet.
 *
 * The user id comes from the PAYMENT ROW, never from the caller's arguments —
 * there is deliberately no `userId` parameter to get wrong. Passing one would be
 * the single most damaging mistake available in this file: one customer's payment
 * crediting another's balance. The DB's UNIQUE index on `paymentId` then makes a
 * replayed webhook a no-op.
 */
export async function creditApprovedPayment(input: {
  paymentId: string;
  amountCents: number;
  /** Free text explaining a partial credit. Stored on the payment row. */
  adminNote?: string;
  idempotencyKey?: string;
}): Promise<WalletResult<WalletMovement>> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    // `amountUsd` and `creditedCents` are read because the credit is BOUNDED BY
    // THE INVOICE: crediting more than the customer paid would let a $5 payment
    // mint $500, and crediting a second time for the same invoice is the exact
    // mistake a partial-credit feature invites.
    select: { id: true, userId: true, status: true, amountUsd: true, creditedCents: true },
  });
  if (!payment) {
    return { ok: false, status: 404, code: "payment_not_found", message: "Payment not found." };
  }
  if (payment.status !== "approved") {
    // An unapproved payment must be refused, because crediting one would let
    // anyone "pay" with a transaction that has not cleared.
    return {
      ok: false,
      status: 409,
      code: "payment_not_approved",
      message: "That payment has not been approved yet.",
    };
  }
  if (input.amountCents <= 0) return badAmount("A credit must be a positive amount.");

  // The credit may never exceed what was actually invoiced. `amountUsd` is a Float,
  // so this is rounded UP to the cent before comparing: rounding down would let a
  // payment of $10.001 be treated as $10.00 of creditable money, and the error
  // would be in the customer's favour every single time.
  const invoicedCents = Math.ceil(payment.amountUsd * 100);
  const alreadyCredited = payment.creditedCents ?? 0;
  const remaining = invoicedCents - alreadyCredited;
  if (input.amountCents > remaining) {
    return {
      ok: false,
      status: 422,
      code: "credit_exceeds_payment",
      message:
        remaining <= 0
          ? "That payment has already been credited in full."
          : `That payment has ${formatCents(remaining)} left to credit.`,
    };
  }

  const note = checkNote(input.adminNote);
  if (!note.ok) return note;

  return move(payment.userId, {
    kind: "purchase_credit",
    amountCents: input.amountCents,
    paymentId: payment.id,
    idempotencyKey: input.idempotencyKey ?? `payment:${payment.id}`,
    note: note.value ?? "Payment approved",
    // The payment's own record of what the wallet was told, written in the SAME
    // transaction. Doing it afterwards would leave a window in which the balance
    // has moved but `creditedCents` still says nothing was credited — and that
    // window is exactly what a "you took my money and gave me no credit" ticket
    // is about. Doing it inside also makes the bound above self-enforcing: the
    // UNIQUE index on paymentId means this hook runs at most once per payment.
    alsoWrite: async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { creditedCents: alreadyCredited + input.amountCents, ...(note.value ? { adminNote: note.value } : {}) },
      });
    },
  });
}

/**
 * Move a balance by hand, as an admin.
 *
 * The note is REQUIRED. "Who gave this user money, and why" is the only question
 * this row will ever be asked, and a row with a null note answers it with a shrug
 * — so an unlabelled adjustment is refused at the only place that can enforce it.
 */
export async function adminAdjustBalance(input: {
  userId: string;
  amountCents: number;
  adminId: string;
  note: string;
}): Promise<WalletResult<WalletMovement>> {
  const note = checkNote(input.note);
  if (!note.ok) return note;
  if (!note.value) {
    return {
      ok: false,
      status: 422,
      code: "note_required",
      message: "Say why you are changing this balance — the note is what makes it auditable later.",
    };
  }
  return move(input.userId, {
    kind: "admin_adjust",
    amountCents: input.amountCents,
    adminId: input.adminId,
    note: note.value,
  });
}

/**
 * Give a user money by hand, as an admin (PLAN_TASK_167 W3).
 *
 * WHY THIS IS NOT JUST `adminAdjustBalance` UNDER A NEW NAME. The two ledger kinds
 * mean different things to whoever reads the statement later: `admin_grant` is
 * "we decided to give you this", `admin_adjust` is "we corrected something". A
 * single sign-based branch is what makes the distinction true forever, and it lives
 * HERE rather than in the route because §3.4 of the plan is a rule about the ledger's
 * meaning, not about an HTTP handler — a second caller that picked its own `kind`
 * from the sign would quietly break the promise the kind makes.
 *
 * The note and the adminId are both mandatory, for the reason given on
 * `adminAdjustBalance`: an unattributed balance change is a support incident.
 */
export async function grantBalance(input: {
  userId: string;
  amountCents: number;
  adminId: string;
  note: string;
  /** Replay guard, UNIQUE when present. See `move()`. */
  idempotencyKey?: string;
}): Promise<WalletResult<WalletMovement>> {
  const note = checkNote(input.note);
  if (!note.ok) return note;
  if (!note.value) {
    return {
      ok: false,
      status: 422,
      code: "note_required",
      message: "Say why you are giving this user money — the note is what makes it auditable later.",
    };
  }
  if (!Number.isInteger(input.amountCents)) return badAmount("Amounts are in whole cents.");
  // A zero "grant" is a note wearing a money row's clothes; `move()` would refuse
  // it too, but saying so here names the real problem, which is a missing amount.
  if (input.amountCents === 0) {
    return badAmount("Enter an amount — a grant of zero changes nothing.");
  }
  return move(input.userId, {
    kind: input.amountCents > 0 ? "admin_grant" : "admin_adjust",
    amountCents: input.amountCents,
    adminId: input.adminId,
    note: note.value,
    idempotencyKey: input.idempotencyKey,
  });
}
/**
 * Set (or change, or revoke) a user's postpaid credit line.
 *
 * The one wallet operation that does NOT go through `move()`, because it moves a
 * ceiling rather than money — and it writes its own ledger row anyway, so "when
 * did this customer stop having a credit line" has an answer. Same
 * compare-and-swap as `move()`, on `postpaidLimitCents` instead of the balance,
 * for the same reason: two admins clicking at once must not silently interleave.
 *
 * A negative limit is refused here AND by a CHECK in the migration. Belt and
 * braces on purpose — the CHECK is what protects the data from a psql session,
 * and this is what turns that failure into a sentence a human can act on.
 */
export async function setPostpaidLimit(input: {
  userId: string;
  limitCents: number;
  adminId: string;
  note?: string;
}): Promise<WalletResult<{ postpaidLimitCents: number }>> {
  if (!Number.isInteger(input.limitCents)) return badAmount("Credit limits are in whole cents.");
  if (input.limitCents < 0) {
    return badAmount("A credit limit cannot be negative — use 0 to put an account back on prepaid.");
  }
  const note = checkNote(input.note);
  if (!note.ok) return note;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, balanceCents: true, postpaidLimitCents: true },
    });
    if (!user) return notFound();

    const grant = input.limitCents > user.postpaidLimitCents;
    const written = await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: input.userId, postpaidLimitCents: user.postpaidLimitCents },
        data: { postpaidLimitCents: input.limitCents },
      });
      if (count === 0) return false;
      await tx.walletLedgerEntry.create({
        data: {
          userId: input.userId,
          kind: grant ? "postpaid_grant" : "postpaid_revoke",
          // Zero: this row moves a CEILING, not money, so the sum of the ledger's
          // amountCents stays equal to the balance at all times.
          amountCents: 0,
          balanceAfterCents: user.balanceCents,
          postpaidLimitAfterCents: input.limitCents,
          adminId: input.adminId,
          note: note.value ?? null,
        },
      });
      return true;
    });
    if (written) return { ok: true, value: { postpaidLimitCents: input.limitCents } };
  }

  return {
    ok: false,
    status: 409,
    code: "wallet_contended",
    message: "That account was being changed at the same time. Please try again.",
  };
}