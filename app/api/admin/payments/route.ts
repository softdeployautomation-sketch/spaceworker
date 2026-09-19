import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// GET /api/admin/payments — flagged + pending payments with user email and last
// check, PLUS (2026-09-19) any "approved" EXE-product payment with no matching
// ExeLicense row — a reconciliation safety net. handleApprovedPayment now
// reverts a failed license mint back to "flagged" going forward (see
// lib/license-service.ts), but this catches any payment that got stuck
// "approved" with no license BEFORE that fix existed, since this status
// combination would otherwise never surface anywhere in admin.
export async function GET() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [payments, strandedApproved] = await Promise.all([
    prisma.payment.findMany({
      where: { status: { in: ["flagged", "pending"] } },
      include: {
        user: { select: { email: true } },
        attempts: { orderBy: { checkedAt: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findMany({
      where: {
        status: "approved",
        product: { not: "web_subscription" },
        exeLicense: null,
      },
      include: {
        user: { select: { email: true } },
        attempts: { orderBy: { checkedAt: "desc" }, take: 1 },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return NextResponse.json([
    ...strandedApproved.map((p) => ({ ...p, status: "approved_no_license" })),
    ...payments,
  ]);
}