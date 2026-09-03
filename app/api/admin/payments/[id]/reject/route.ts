import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// POST /api/admin/payments/[id]/reject — manually reject the payment.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.payment.update({ where: { id }, data: { status: "rejected" } });

  return NextResponse.json({ ok: true });
}