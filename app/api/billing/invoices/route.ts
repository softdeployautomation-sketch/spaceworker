import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// GET /api/billing/invoices — the caller's own premium invoices, newest first,
// capped at 10. TASK_184 B4, delivery half of B3's admin-issued invoices.
//
// SESSION-SCOPED BY QUERY, not by an admin check: these rows are the money an
// admin asked this specific user to pay, so they are visible to that user only
// (B3's contract). The `userId` in the where-clause IS the authorization — there
// is no id parameter to tamper with, so there is nothing to forge.
//
// Read-only: creating/editing/sending an invoice is admin-only (B3 routes).
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invoices = await prisma.premiumInvoice.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      plan: true,
      tier: true,
      amountUsd: true,
      status: true,
      methods: true,
      createdAt: true,
      paidAt: true,
      // paidAt is the only timestamp a user needs; admin-issued rows also carry
      // updatedAt, but exposing it would leak edit history (TASK_181 rule: the
      // user sees the invoice, never the admin's workflow).
    },
  });

  return NextResponse.json({ invoices });
}
