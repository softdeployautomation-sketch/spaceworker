import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { WALLET_TOPUP_PRODUCT_ID } from "@/lib/products";

// GET /api/billing/status — most recent SUBSCRIPTION payment for the signed-in user.
//
// PLAN_TASK_167 W4: `wallet_topup` rows are EXCLUDED. This route feeds the
// "Upgrade to Pro" card on /dashboard/billing, and without the filter a customer
// who topped up $10 would see that card replaced by a top-up order rendered as
// "Pro plan — Payment Pending", which is a lie about a product they did not buy
// and an invitation to resubmit. A top-up has its own state, shown by its own
// UI; it must never be reported as somebody's subscription.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payment = await prisma.payment.findFirst({
    where: { userId: session.userId, product: { not: WALLET_TOPUP_PRODUCT_ID } },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      kind: true,
      amountUsd: true,
      txHash: true,
      createdAt: true,
      updatedAt: true,
      autoApproved: true,
    },
  });

  if (!payment) return NextResponse.json({ status: null });
  return NextResponse.json(payment);
}