import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { revokeVantraLink } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// Task 93 — admin visibility + revoke for Vantra links (TASK_93 deliverable 5).
//   GET  → every link with its user email + live device count per link.
//   POST { linkId } → revoke (tears the install surface down; audited).

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const links = await db.vantraLink.findMany({
    orderBy: { createdAt: "desc" },
    include: { user: { select: { email: true } } },
  });
  const deviceCounts = await db.device.groupBy({
    by: ["userId"],
    _count: { id: true },
    where: { userId: { in: links.map((l) => l.userId) } },
  });
  const countByUser = new Map(deviceCounts.map((d) => [d.userId, d._count.id]));

  return NextResponse.json({
    links: links.map((l) => ({
      id: l.id,
      email: l.user.email,
      orgId: l.orgId,
      orgName: l.orgName,
      status: l.status,
      deviceCount: countByUser.get(l.userId) ?? 0,
      lastSyncedAt: l.lastSyncedAt,
      lastError: l.lastError,
      createdAt: l.createdAt,
    })),
  });
}

export async function POST(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { linkId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const linkId = typeof body.linkId === "string" ? body.linkId : "";
  if (!linkId) return NextResponse.json({ error: "linkId is required" }, { status: 400 });

  try {
    await revokeVantraLink(linkId, "admin");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : "revoke_failed";
    return NextResponse.json({ error: code }, { status: code === "no_link" ? 404 : 502 });
  }
}