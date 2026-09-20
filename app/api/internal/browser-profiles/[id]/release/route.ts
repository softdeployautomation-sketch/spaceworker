import { NextResponse } from "next/server";
import { requireInternalBearer } from "@/lib/internal-auth";
import { prisma } from "@/lib/prisma";

// POST /api/internal/browser-profiles/[id]/release — the job runner marks the
// profile idle when the Chrome session ends. Bearer-token gated.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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