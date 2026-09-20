import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/admin/campaigns — Task 50: read-only admin visibility into every
// EmailCampaign across all users, with the send progress (queued vs sent) and
// which mailboxes it is using. READ-ONLY — no pause/delete/edit from here.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const campaigns = await db.emailCampaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 400,
    include: {
      user: { select: { email: true } },
      _count: { select: { items: true } },
      items: {
        where: { status: "sent" },
        select: { id: true },
      },
    },
  });

  return NextResponse.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      recipientCount: c._count.items,
      sentCount: c.items.length,
      searchJobId: c.searchJobId,
      batchSize: c.batchSize,
      minSendDelaySeconds: c.minSendDelaySeconds,
      maxSendDelaySeconds: c.maxSendDelaySeconds,
      sendingStartedAt: c.sendingStartedAt?.toISOString() ?? null,
      userEmail: c.user.email,
      createdAt: c.createdAt.toISOString(),
    })),
  });
}