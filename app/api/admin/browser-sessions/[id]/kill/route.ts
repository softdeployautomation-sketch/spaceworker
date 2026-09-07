import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { browserRuntime } from "@/lib/browser-runtime";

// POST /api/admin/browser-sessions/[id]/kill — individual-session kill switch:
// kills ONE user's browser process without touching any other concurrent
// session, then releases its profile back to idle. Mirrors the Task 6
// force-release pattern but operating on the live session + its process.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const row = await prisma.browserSession.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Kill only this session's process/container.
  const runtimeResult = await browserRuntime.kill(row.id);

  await prisma.$transaction([
    prisma.browserSession.update({
      where: { id: row.id },
      // Same as the customer-facing stop route: no info worth showing for a
      // stopped session, so hide it from their list immediately. Admin's own
      // audit endpoint has no hiddenAt filter, so the record isn't lost.
      data: { status: "stopped", endedAt: new Date(), hiddenAt: new Date() },
    }),
    prisma.browserProfile.updateMany({
      where: { id: row.profileId },
      data: { status: "idle", lastUsedAt: new Date() },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    warning: runtimeResult.ok ? undefined : runtimeResult.error,
  });
}