import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// GET /api/admin/payments — flagged + pending payments with user email and last check.
export async function GET() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const payments = await prisma.payment.findMany({
    where: { status: { in: ["flagged", "pending"] } },
    include: {
      user: { select: { email: true } },
      attempts: { orderBy: { checkedAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(payments);
}