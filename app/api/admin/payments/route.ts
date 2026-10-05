import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { WALLET_TOPUP_PRODUCT_ID } from "@/lib/products";

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
        // PLAN_TASK_167 W4 — a wallet top-up is an approved product-shaped payment
        // that will NEVER have an ExeLicense, because approving it credits a wallet
        // and grants nothing. Without this exclusion every top-up ever approved
        // would appear here forever as "approved_no_license", burying the genuine
        // reconciliation safety net this query exists to be.
        product: { notIn: ["web_subscription", WALLET_TOPUP_PRODUCT_ID] },
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