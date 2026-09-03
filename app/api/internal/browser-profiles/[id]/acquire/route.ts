import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// POST /api/internal/browser-profiles/[id]/acquire — the job runner locks a
// profile before launching Chrome. Bearer-token gated; returns dirPath.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const profile = await prisma.browserProfile.findUnique({ where: { id } });
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (profile.status === "in_use") {
    return NextResponse.json(
      { error: "Profile is already in use" },
      { status: 409 }
    );
  }

  const updated = await prisma.browserProfile.update({
    where: { id: profile.id },
    data: { status: "in_use" },
  });

  // dirPath IS sent here — internal only, the job runner needs it for --user-data-dir.
  return NextResponse.json({ id: updated.id, dirPath: updated.dirPath, name: updated.name });
}