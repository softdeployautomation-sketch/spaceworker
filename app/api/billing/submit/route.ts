import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { getAdminSettings } from "@/lib/admin-settings";
import { verifyBtcPayment, verifyUsdtPayment, isPendingNote } from "@/lib/crypto-verify";

const KINDS = ["btc", "usdt_trc20"] as const;
type Kind = (typeof KINDS)[number];

// POST /api/billing/submit — body: { kind: "btc" | "usdt_trc20", txHash: string }
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { kind?: unknown; txHash?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const kind = body.kind;
  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  if (typeof kind !== "string" || !KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: "Invalid payment method" }, { status: 400 });
  }
  const paymentKind = kind as Kind;
  if (!txHash) {
    return NextResponse.json({ error: "Transaction hash is required" }, { status: 400 });
  }

  const settings = await getAdminSettings();
  const toAddress = paymentKind === "btc" ? settings.btcWallet : settings.usdtWallet;
  if (!toAddress) {
    return NextResponse.json({ error: "Wallet not configured" }, { status: 400 });
  }

  const existing = await prisma.payment.findUnique({ where: { txHash } });
  if (existing) {
    return NextResponse.json({ error: "Transaction hash already submitted" }, { status: 400 });
  }

  const payment = await prisma.payment.create({
    data: {
      userId: session.userId,
      kind: paymentKind,
      amountUsd: settings.planPriceUsd,
      txHash,
      toAddress,
      status: "pending",
    },
  });

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
    await prisma.user.update({ where: { id: session.userId }, data: { tier: 1 } });
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