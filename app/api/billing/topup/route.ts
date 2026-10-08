import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";
import { WALLET_TOPUP_PRODUCT_ID } from "@/lib/products";

// POST /api/billing/topup — the two halves of a top-up, in one route.
//
//   * body { amountUsd, kind? }        → opens the order (creates the Payment)
//   * body { paymentId, txHash }       → attaches the hash to an open order
//
// WHY THE HASH IS SUBMITTED HERE AND NOT TO /api/billing/submit. That route
// resolves its product through `getProduct()`, which does not know `wallet_topup`
// and answers "Unknown product" — correct, because a top-up is not a store product.
// Rather than widen that route's product resolution (which every subscription and
// EXE purchase flows through) to accommodate a product that grants nothing, the
// top-up owns both of its own steps. One route, one product, nothing shared with
// the path that mints licences.
//
// THIS ROUTE CREDITS NOTHING. That is not an omission, it is the whole design
// (plan §8.6): on-chain confirmation is not payment, and even a genuinely confirmed
// transaction only earns a `pending_review` row. An admin decides. A route that
// minted credit the moment a hash verified would be a wallet anyone could fill from
// a payment they did not make.
//
// Consequently there is no call to `creditTopup`, `creditApprovedPayment` or
// `handleApprovedPayment` anywhere below, and the response says "pending" rather
// than reporting a balance. The credit happens in ONE place only: the admin approve
// route's `wallet_topup` branch.
//
// A top-up also needs an EXISTING SESSION (unlike an EXE purchase, which may be
// made by a bare email): the credit lands on a wallet that already belongs to
// somebody, and "somebody" has to be the person in the room.

const KINDS = ["btc", "usdt_trc20", "usdt_erc20"] as const;
type Kind = (typeof KINDS)[number];

// A top-up is capped as well as floored. There is no maximum in the schema because
// the owner may not want one; this is a sanity bound on a single order, not a
// commercial rule — it stops a fat-fingered `1000000` from creating an invoice no
// admin will ever be able to eyeball at a glance. An admin approving that order is
// a deliberate, manual act, and nothing here prevents it.
const MAX_TOPUP_USD = 10_000;

// GET /api/billing/topup — the two numbers the top-up form must show BEFORE the
// customer types anything (plan §4a: "show it in the UI so the validation error
// never surprises"). Read-only and session-scoped: the floor is an AdminSetting
// so the owner can change it without a deploy, and the form reads it live rather
// than hardcoding a $5 that would silently disagree with the server's rule.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await getAdminSettings();
  return NextResponse.json({
    minimumUsd: settings.walletTopupMinUsd,
    maximumUsd: MAX_TOPUP_USD,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { amountUsd?: unknown; kind?: unknown; paymentId?: unknown; txHash?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // A `paymentId` means "attach my hash to the order I already opened" — the
  // second half of the flow. Branching on the presence of the id rather than on a
  // separate route keeps the two halves impossible to mismatch: both are
  // session-scoped, both are the same product, and there is no second file whose
  // auth rules could drift from this one's.
  if (typeof body.paymentId === "string" && body.paymentId.length > 0) {
    return attachHash(body.paymentId, body.txHash, session.userId);
  }

  return openOrder(body, session.userId);
}

/**
 * Step 2 — the customer has paid and is telling us the transaction hash.
 *
 * SCOPED TO THE SESSION'S OWN USER, and the lookup is `userId` + `product` rather
 * than a bare `findUnique` on the id. A bare lookup would let a signed-in customer
 * attach their hash to somebody ELSE's open top-up — which on its own only writes a
 * hash, but is exactly the shape of confusion that later becomes exactly the shape
 * of theft. The compound where-clause means the row is simply not found.
 */
async function attachHash(paymentId: string, txHashRaw: unknown, userId: string) {
  const txHash = typeof txHashRaw === "string" ? txHashRaw.trim() : "";
  // TASK_185 follow-up (owner: "even the hash is not required for topup") —
  // an empty hash is a valid "submit for manual review" (same contract as
  // /api/billing/submit). The 400 that used to live here is gone; everything
  // below simply runs with txHash = null.

  const existing = await prisma.payment.findFirst({
    where: { id: paymentId, userId, product: WALLET_TOPUP_PRODUCT_ID },
  });
  if (!existing) {
    return NextResponse.json({ error: "Top-up not found" }, { status: 404 });
  }
  if (existing.status === "approved") {
    return NextResponse.json(
      { error: "That top-up is already approved." },
      { status: 400 },
    );
  }
  if (existing.status === "rejected") {
    return NextResponse.json(
      { error: "That top-up was declined. Open a new one and try again." },
      { status: 400 },
    );
  }

  // Hashes are UNIQUE across the table, so a hash already used by ANY payment —
  // including a subscription — is refused here. Reusing one is never legitimate: it
  // would mean a single transaction counted as payment twice. Skipped when no
  // hash was given (NULL never collides under @unique — multiple NULLs allowed).
  if (txHash) {
    const clash = await prisma.payment.findUnique({ where: { txHash } });
    if (clash) {
      return NextResponse.json({ error: "Transaction hash already submitted" }, { status: 400 });
    }
  }

  const payment = await prisma.payment.update({
    where: { id: existing.id },
    data: { txHash: txHash || null },
  });
  await prisma.paymentVerificationAttempt.create({
    data: {
      paymentId: payment.id,
      success: false,
      // Not "unverified" so much as "NOT auto-verifiable, by design". Recorded as
      // a failed attempt on purpose: this row is the audit trail an admin reads to
      // see what the customer said, and the admin queue is where it belongs.
      // Nothing here runs a chain lookup, and the internal poller skips
      // `wallet_topup` rows entirely.
      note: txHash
        ? "Hash received — awaiting manual review (top-ups are never auto-approved)"
        : "No transaction hash provided — awaiting manual review",
    },
  });

  return NextResponse.json({
    paymentId: payment.id,
    status: payment.status,
    note: "Received. We'll confirm the payment and add the funds to your wallet.",
  });
}

/** Step 1 — open the order. See the route header for why this credits nothing. */
async function openOrder(body: { amountUsd?: unknown; kind?: unknown }, userId: string) {
  const kind = typeof body.kind === "string" && body.kind ? body.kind : "usdt_trc20";
  if (!KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
  }

  // The amount arrives in DOLLARS because that is what the customer typed. The
  // `amountUsd` column is already a Float in dollars (it predates the wallet), so
  // storing dollars is the schema's existing convention, not a new inconsistency.
  // The CENTS the wallet is eventually credited come from `creditApprovedPayment`,
  // which recomputes them from this stored amount — never from anything the client
  // sent at approval time.
  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd)) {
    return NextResponse.json({ error: "Enter an amount to add" }, { status: 400 });
  }

  const settings = await getAdminSettings();
  const minimumUsd = settings.walletTopupMinUsd;

  // Floor checked BEFORE the ceiling so the common mistake (too small) gets the
  // actionable message naming the actual minimum, rather than a cap error.
  if (amountUsd < minimumUsd) {
    return NextResponse.json(
      { error: `The minimum top-up is $${minimumUsd.toFixed(2)}.` },
      { status: 400 },
    );
  }
  if (amountUsd > MAX_TOPUP_USD) {
    return NextResponse.json(
      { error: `For amounts above $${MAX_TOPUP_USD.toLocaleString()}, email us and we'll take the transfer directly.` },
      { status: 400 },
    );
  }
  // Two decimals, and the ROUNDING IS UP, matching `creditApprovedPayment`'s own
  // rule. A customer who asks for $10.001 must never be invoiced $10.00 and then
  // credited $10.00 — that is a silent shortfall, and the error is always in the
  // house's favour. Rounding up means the invoice is never short of the credit.
  const amountUsdRounded = Math.ceil(amountUsd * 100) / 100;

  const toAddress =
    kind === "btc"
      ? settings.btcWallet
      : kind === "usdt_erc20"
        ? settings.usdtErc20Wallet
        : settings.usdtWallet;
  if (!toAddress) {
    // Same string as the subscription checkout uses, and the same cause: this is
    // the CRYPTO PAYOUT ADDRESS, not the SpaceWorker wallet (plan §1). The two
    // subsystems both use the word "wallet"; do not let it send you to the wrong one.
    return NextResponse.json({ error: "Wallet not configured" }, { status: 400 });
  }

  const payment = await prisma.payment.create({
    data: {
      userId,
      kind: kind as Kind,
      product: WALLET_TOPUP_PRODUCT_ID,
      amountUsd: amountUsdRounded,
      // No txHash yet: the customer sends the money and then submits the hash as
      // step 2. Until then there is nothing to look up on-chain, and a null hash
      // also keeps the row out of the internal poller's 24h auto-reject — the same
      // protection a hash-less subscription payment has always had.
      txHash: null,
      toAddress,
      status: "pending",
    },
  });

  await prisma.paymentVerificationAttempt.create({
    data: {
      paymentId: payment.id,
      success: false,
      note: "Wallet top-up opened — awaiting payment",
    },
  });

  return NextResponse.json({
    paymentId: payment.id,
    // Explicitly NOT "approved" and NOT a balance. See the route header.
    status: "pending",
    kind,
    toAddress,
    amountUsd: payment.amountUsd,
    note: "Send the exact amount to this address, then submit your transaction hash (optional — we confirm the payment manually). Your wallet is credited once we confirm it.",
  });
}

