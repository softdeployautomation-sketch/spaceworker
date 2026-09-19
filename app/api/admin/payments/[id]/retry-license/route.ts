import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { handleApprovedPayment } from "@/lib/license-service";

// POST /api/admin/payments/[id]/retry-license — 2026-09-19. The regular
// approve route (../approve/route.ts) refuses an already-"approved" payment
// ("already finalized"), so a payment that got stuck "approved" with no
// ExeLicense (license issuance threw after the status write — see
// lib/license-service.ts's comment) had no way to be retried from admin.
// This calls the exact same idempotent handleApprovedPayment() but skips
// that guard, specifically for a payment that's still "approved" and still
// has no matching license row.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: { exeLicense: true },
  });
  if (!payment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (payment.status !== "approved") {
    return NextResponse.json(
      { error: "Only an approved payment can have its license retried." },
      { status: 400 },
    );
  }
  if (payment.exeLicense) {
    return NextResponse.json({ error: "This payment already has a license." }, { status: 400 });
  }

  await handleApprovedPayment(id);
  return NextResponse.json({ ok: true });
}
