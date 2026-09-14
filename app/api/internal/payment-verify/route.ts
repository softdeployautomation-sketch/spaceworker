import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyBtcPayment, verifyUsdtPayment, isPendingNote } from "@/lib/crypto-verify";
import { handleApprovedPayment } from "@/lib/license-service";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// POST only. Gated by bearer token; run via deploy/payment-verify.service timer.
// Re-checks all pending payments and approves those now confirmed on-chain.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Task 44 — a null txHash means the buyer submitted without one (manual
  // review only, per app/api/billing/submit/route.ts). Exclude those rows
  // entirely: there is nothing to look up on-chain, and letting them fall
  // through to the "not found" -> 24h auto-reject path below would silently
  // reject a payment before an admin ever saw it.
  const pending = await prisma.payment.findMany({
    where: { status: "pending", txHash: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  let approved = 0;
  for (const payment of pending) {
    // Prisma's generated types don't narrow txHash to non-null from the query
    // filter above — this is a defensive belt-and-braces guard, not expected
    // to ever trigger given the where clause already excludes nulls.
    if (!payment.txHash) continue;
    const result =
      payment.kind === "btc"
        ? await verifyBtcPayment(payment.txHash, payment.toAddress, payment.amountUsd)
        : await verifyUsdtPayment(payment.txHash, payment.toAddress, payment.amountUsd);

    await prisma.paymentVerificationAttempt.create({
      data: { paymentId: payment.id, success: result.ok, note: result.note },
    });

    if (result.ok) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "approved", autoApproved: true },
      });
      // Finalize into the product's consequence (tier bump / license issue) via
      // the single shared handler — Task 42.
      await handleApprovedPayment(payment.id);
      approved += 1;
    } else if (isPendingNote(result.note)) {
      // Still not found — reject once the payment is older than 24h.
      const ageMs = Date.now() - payment.createdAt.getTime();
      if (ageMs > TWENTY_FOUR_HOURS_MS) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: "rejected" },
        });
      }
    }
    // Other failures are already "flagged" by the submit route; leave pending rows as-is.
  }

  return NextResponse.json({ checked: pending.length, approved });
}