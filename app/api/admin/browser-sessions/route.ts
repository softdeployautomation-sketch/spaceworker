import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";

// GET /api/admin/browser-sessions — list every interactive session with the
// owning user + profile, so the admin can audit and kill individual sessions.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.browserSession.findMany({
    include: {
      user: { select: { email: true } },
      profile: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      proxyMode: r.proxyMode,
      exitNodeId: r.exitNodeId,
      exitIpSnapshot: r.exitIpSnapshot,
      containerId: r.containerId,
      userEmail: r.user.email,
      profileName: r.profile.name,
      startedAt: r.startedAt?.toISOString() ?? null,
      endedAt: r.endedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }))
  );
}