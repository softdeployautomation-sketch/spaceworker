import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { deleteProfileDir } from "@/lib/browser-profiles";

// DELETE /api/browser-profiles/[id] — delete a profile's DB record + directory.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const profile = await prisma.browserProfile.findFirst({ where: { id, userId: session.userId } });
  if (!profile) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (profile.status === "in_use") {
    return NextResponse.json(
      { error: "Cannot delete a profile that is currently in use" },
      { status: 400 }
    );
  }

  // DB first — the directory is best-effort cleanup on top of it.
  await prisma.browserProfile.delete({ where: { id: profile.id } });

  try {
    await deleteProfileDir(profile.dirPath);
  } catch (e) {
    // Swallow — DB is the source of truth; leftover dir is harmless.
    console.error("Failed to delete profile directory", e);
  }

  return new NextResponse(null, { status: 204 });
}