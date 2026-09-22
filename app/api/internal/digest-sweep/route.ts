import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireInternalBearer } from "@/lib/internal-auth";
import { buildDailyDigest } from "@/lib/digest";

// Task 92 — the nightly assistant digest sweep. POST /api/internal/digest-sweep,
// gated by INTERNAL_BEARER_TOKEN, hit by the external scheduler each morning
// (deploy/digest-sweep.timer mirrors the automations-sweep pattern). For every
// user with digests enabled AND any activity in the covered day, builds the
// rollup once (unique userId+rollupDate makes re-fires no-ops) and fans it out.

export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The digest covers the previous UTC day. Users with zero activity in the
  // window are skipped entirely (no AI spend, no empty digests).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const prevStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);

  const candidates = await prisma.user.findMany({
    where: { digestEnabled: true },
    select: { id: true },
  });

  const results: Record<string, string> = {};
  let generated = 0;
  let skipped = 0;

  for (const { id } of candidates) {
    // Cheap per-user activity check before any AI spend.
    const [jobs, campaigns, deviceEvents, digests] = await Promise.all([
      prisma.searchJob.count({ where: { userId: id, createdAt: { gte: prevStart, lt: dayStart } } }),
      prisma.emailCampaign.count({ where: { userId: id, createdAt: { gte: prevStart, lt: dayStart } } }),
      prisma.deviceAudit.count({ where: { device: { userId: id }, createdAt: { gte: prevStart, lt: dayStart } } }),
      prisma.payment.count({ where: { userId: id, createdAt: { gte: prevStart, lt: dayStart } } }),
    ]);
    if (jobs + campaigns + deviceEvents + digests === 0) {
      skipped++;
      continue;
    }
    try {
      const res = await buildDailyDigest(id);
      results[id] = res.status;
      if (res.status === "generated") generated++;
    } catch (err) {
      console.error(`[digest-sweep] failed for user ${id}:`, err);
      results[id] = "failed";
    }
  }

  console.log(`[digest-sweep] generated ${generated}, skipped ${skipped} (no activity) of ${candidates.length} eligible`);
  return NextResponse.json({ generated, skipped, eligible: candidates.length, results });
}