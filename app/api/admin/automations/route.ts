import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/admin/automations — Task 50: read-only admin visibility into every
// CampaignAutomation (recurring/scheduled send) across all users, with the
// owning user and last-run outcome. READ-ONLY.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const automations = await db.campaignAutomation.findMany({
    orderBy: { createdAt: "desc" },
    take: 400,
    include: {
      user: { select: { email: true } },
      runs: {
        orderBy: { startedAt: "desc" },
        take: 1,
      },
    },
  });

  return NextResponse.json({
    automations: automations.map((a) => ({
      id: a.id,
      name: a.name,
      leadSource: a.leadSource,
      triggerMode: a.triggerMode,
      scheduleHour: a.scheduleHour,
      scheduleEnabled: a.scheduleEnabled,
      runCount: a.runCount,
      lastRunAt: a.lastRunAt?.toISOString() ?? null,
      lastRunStatus: a.runs[0]?.status ?? null,
      lastRunStartedAt: a.runs[0]?.startedAt.toISOString() ?? null,
      lastRunCompletedAt: a.runs[0]?.completedAt?.toISOString() ?? null,
      userEmail: a.user.email,
      createdAt: a.createdAt.toISOString(),
    })),
  });
}