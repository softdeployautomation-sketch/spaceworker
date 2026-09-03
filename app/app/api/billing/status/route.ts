import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// GET /api/billing/status — most recent payment for the signed-in user.
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payment = await prisma.payment.findFirst({
    where: { userId: session.userId },
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