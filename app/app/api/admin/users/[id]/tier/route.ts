import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// PATCH /api/admin/users/[id]/tier — body: { tier: number }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { tier?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const tier = Number(body.tier);
  if (!Number.isInteger(tier) || tier < 0) {
    return NextResponse.json(
      { error: "tier must be a non-negative integer" },
      { status: 400 }
    );
  }

  const user = await prisma.user
    .update({
      where: { id },
      data: { tier },
      select: { id: true, email: true, tier: true, emailVerified: true, createdAt: true },
    })
    .catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json(user);
}