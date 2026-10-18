import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { buildStallPayload } from "@/lib/campaign-stall";

// TASK_226 — lightweight READ-ONLY stall-visibility payload for the campaign
// detail page. Answers "why isn't mail moving" without SSH-ing into the box:
// fresh queue counts (including the retry backlog), the last successful send,
// the soonest scheduled retry, grouped failure reasons, and each sending
// mailbox's path (host + send region — the exact field behind the 2026-10-18
// "Greeting never received" stall).
//
// Deliberately a SEPARATE lightweight route (same family as recent-sends)
// rather than extra fields on GET /api/campaigns/[id]: that route already
// drags every queue item's resolved subject/body, and this one is polled on a
// timer by an open page. No new table — everything derives from
// EmailQueueItem aggregates / LIMIT-1 lookups on existing indexes
// (@@index([campaignId, status]), @@index([status, nextAttemptAt])).
//
// NO PII: no query here selects toEmail, and buildStallPayload's shape has no
// recipient field — pinned by tests/campaign-stall.test.ts.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    select: { mailboxIds: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [statusCounts, retryCount, lastSent, nextRetry, failureGroups, mailboxes] =
    await Promise.all([
      prisma.emailQueueItem.groupBy({
        by: ["status"],
        where: { campaignId: id },
        _count: { _all: true },
      }),
      // The retry backlog: soft failures revert to "queued" with a future
      // nextAttemptAt (see the drain's catch block) — counting them separately
      // is what lets the UI say "100 waiting to retry" instead of "stalled".
      prisma.emailQueueItem.count({
        where: { campaignId: id, status: "queued", nextAttemptAt: { not: null } },
      }),
      prisma.emailQueueItem.findFirst({
        where: { campaignId: id, status: "sent" },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      }),
      prisma.emailQueueItem.findFirst({
        where: { campaignId: id, status: "queued", nextAttemptAt: { not: null } },
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
      }),
      // DB-side aggregation over the campaign's errored items only (the
      // [campaignId, status] index keeps this bounded); status "queued" here
      // means "errored but re-queued with backoff" = retryable.
      prisma.emailQueueItem.groupBy({
        by: ["error", "errorCategory", "status"],
        where: {
          campaignId: id,
          error: { not: null },
          status: { in: ["queued", "failed"] },
        },
        _count: { _all: true },
      }),
      prisma.mailbox.findMany({
        where: { id: { in: campaign.mailboxIds } },
        select: { label: true, host: true, sendRegion: true },
      }),
    ]);

  const counts = { total: 0, queued: 0, retryScheduled: retryCount, sent: 0, failed: 0 };
  for (const row of statusCounts) {
    const n = row._count._all;
    counts.total += n;
    if (row.status === "sent") counts.sent = n;
    else if (row.status === "failed") counts.failed = n;
    else if (row.status === "queued" || row.status === "pending") counts.queued += n;
  }

  return NextResponse.json(
    buildStallPayload({
      counts,
      lastSentAt: lastSent?.sentAt ?? null,
      nextRetryAt: nextRetry?.nextAttemptAt ?? null,
      failureRows: failureGroups.map((g) => ({
        error: g.error ?? "",
        category: g.errorCategory,
        retryable: g.status === "queued",
      })),
      mailboxes,
    })
  );
}