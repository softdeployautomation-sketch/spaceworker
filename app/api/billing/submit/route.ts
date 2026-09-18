import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";
import { verifyBtcPayment, verifyUsdtPayment, isPendingNote } from "@/lib/crypto-verify";
import { handleApprovedPayment } from "@/lib/license-service";
import { hashPassword } from "@/lib/auth";
import { getProduct, WEB_SUBSCRIPTION } from "@/lib/products";

const KINDS = ["btc", "usdt_trc20", "usdt_erc20"] as const;
type Kind = (typeof KINDS)[number];

function isEmail(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.includes("@");
}

// POST /api/billing/submit — body: { kind, txHash, product?, email? }
//
// product defaults to web_subscription (back-compat). For a web subscription an
// existing session is required and the email is ignored. For an EXE product the
// buyer may be a not-yet-signed-up visitor: an email is required then, and a
// User row is created inline if one doesn't exist yet (the license is delivered
// to that address) — Task 27 Part A's "no account required first" buy path.
export async function POST(req: Request) {
  const session = await getSession();

  let body: { kind?: unknown; txHash?: unknown; product?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const kind = body.kind;
  // Task 44 — the hash is now OPTIONAL: a buyer who doesn't know how to find it
  // can still submit, and the payment sits "pending" for manual admin review
  // only (no on-chain check runs without a real hash to look up, and the
  // internal poller explicitly skips these rows too — see below and
  // app/api/internal/payment-verify/route.ts).
  const txHashRaw = typeof body.txHash === "string" ? body.txHash.trim() : "";
  const txHash: string | null = txHashRaw || null;
  if (typeof kind !== "string" || !KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
  }
  const paymentKind = kind as Kind;

  const productId = typeof body.product === "string" && body.product ? body.product : WEB_SUBSCRIPTION.id;
  const product = getProduct(productId);
  if (!product) {
    return NextResponse.json({ error: "Unknown product" }, { status: 400 });
  }

  let userId: string | null = null;
  if (product.kind === "web") {
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    userId = session.userId;
  } else {
    // EXE — resolve the buyer: an existing session wins, otherwise the email.
    if (session) {
      userId = session.userId;
    } else {
      const email = body.email;
      if (!isEmail(email)) {
        return NextResponse.json(
          { error: "A valid email is required to deliver your license key" },
          { status: 400 },
        );
      }
      userId = await findOrCreateUser(email.trim().toLowerCase());
    }
  }

  const settings = await getAdminSettings();
  const toAddress =
    paymentKind === "btc"
      ? settings.btcWallet
      : paymentKind === "usdt_erc20"
        ? settings.usdtErc20Wallet
        : settings.usdtWallet;
  if (!toAddress) {
    return NextResponse.json({ error: "Wallet not configured" }, { status: 400 });
  }

  // A null txHash never collides (Postgres allows multiple NULLs under
  // @unique) — only check for a real duplicate when a real hash was given.
  if (txHash) {
    const existing = await prisma.payment.findUnique({ where: { txHash } });
    if (existing) {
      return NextResponse.json({ error: "Transaction hash already submitted" }, { status: 400 });
    }
  }

  const payment = await prisma.payment.create({
    data: {
      userId,
      kind: paymentKind,
      product: product.id,
      amountUsd: settings[product.priceField],
      txHash,
      toAddress,
      status: "pending",
    },
  });

  // No hash given — nothing to look up on-chain. Leave it "pending" for manual
  // admin review only; never call the verifier with an empty/null hash, and
  // never let it enter the on-chain result branches below (which is also what
  // keeps it out of the internal poller's 24h auto-reject timer — that poller
  // explicitly filters txHash: { not: null }).
  if (!payment.txHash) {
    await prisma.paymentVerificationAttempt.create({
      data: { paymentId: payment.id, success: false, note: "No transaction hash provided — awaiting manual review" },
    });
    return NextResponse.json({ paymentId: payment.id, status: "pending", note: "Awaiting manual review" });
  }

  // USDT-ERC20 has no automated on-chain checker yet (verifyUsdtPayment only
  // covers TRC20/Tron, via Tronscan's public API) — route straight to manual
  // review rather than guessing or leaving it silently uncalled. Same shape as
  // the no-hash path above; kept separate because a real hash WAS given here
  // (worth recording that fact for whoever reviews it manually).
  if (paymentKind === "usdt_erc20") {
    await prisma.paymentVerificationAttempt.create({
      data: {
        paymentId: payment.id,
        success: false,
        note: "USDT-ERC20 has no automated verification yet — awaiting manual review",
      },
    });
    return NextResponse.json({ paymentId: payment.id, status: "pending", note: "Awaiting manual review" });
  }

  const result =
    paymentKind === "btc"
      ? await verifyBtcPayment(payment.txHash, payment.toAddress, payment.amountUsd)
      : await verifyUsdtPayment(payment.txHash, payment.toAddress, payment.amountUsd);

  let status = "pending";
  if (result.ok) {
    status = "approved";
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "approved", autoApproved: true },
    });
    // Finalize into the product's consequence (tier bump for web, license issue
    // for EXE) via the single shared handler.
    await handleApprovedPayment(payment.id);
  } else if (isPendingNote(result.note)) {
    status = "pending"; // might confirm soon — rely on the internal poller
  } else {
    status = "flagged";
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "flagged" } });
  }

  await prisma.paymentVerificationAttempt.create({
    data: { paymentId: payment.id, success: result.ok, note: result.note },
  });

  return NextResponse.json({ paymentId: payment.id, status, note: result.note });
}

async function findOrCreateUser(email: string): Promise<string> {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing.id;

  // Inline account for an EXE buyer who isn't signed up yet. A random password
  // (no one signs in with it) tied to emailVerified:true keeps the account
  // usable after a future password reset; the license itself is delivered by
  // email regardless of login state.
  const randomPassword = randomBytes(24).toString("hex");
  const passwordHash = await hashPassword(randomPassword);
  // Tier 1 trial — MUST pin tier: 0 explicitly. The schema default is now 1
  // (trial), but this inline EXE buyer must stay tier 0: the login route keeps
  // them license_only while `tier < 5` AND acceptedTermsAt is null, so a trial
  // tier here would silently hand the entire web product to a non-signup buyer.
  // (campaign-templates.ts already pins its template-owner account to 0.)
  const created = await db.user.create({
    data: { email, passwordHash, emailVerified: true, tier: 0 },
  });
  return created.id;
}