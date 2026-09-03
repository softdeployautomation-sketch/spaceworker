import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// POST /api/admin/browser-profiles/[id]/force-release — unsticks a profile
// left "in_use" by a crashed job. Admin session required.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const profile = await prisma.browserProfile.findUnique({ where: { id } });
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.browserProfile.update({
    where: { id },
    data: { status: "idle", lastUsedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}