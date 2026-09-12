import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 27, Part B — run-summary / drill-down (Task 09). GET a single run with:
// duration by phase (extraction / total from startedAt/extractionCompletedAt/completedAt),
// leads extracted, per-mailbox send breakdown, and links through to the
// underlying SearchJob + EmailCampaign via their ids.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, runId } = await params;

  const automation = await prisma.campaignAutomation.findFirst({
    where: { id, userId: session.userId },
    select: { id: true, name: true, triggerMode: true, leadSource: true, mailboxIds: true },
  });
  if (!automation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const run = await prisma.campaignAutomationRun.findFirst({
    where: { id: runId, automationId: id },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [searchJob, campaign] = await Promise.all([
    run.searchJobId
      ? prisma.searchJob.findUnique({
          where: { id: run.searchJobId },
          select: {
            id: true, query: true, status: true, currentStep: true, error: true, createdAt: true,
            _count: { select: { leads: true } },
          },
        })
      : null,
    run.campaignId
      ? prisma.emailCampaign.findUnique({
          where: { id: run.campaignId },
          select: { id: true, name: true, status: true, mailboxIds: true },
        })
      : null,
  ]);

  // Live per-mailbox breakdown from the created campaign's queue, when present.
  const mailboxSends = campaign
    ? await prisma.emailQueueItem.groupBy({
        by: ["mailboxId"],
        where: { campaignId: campaign.id },
        _count: { _all: true },
      })
    : [];

  return NextResponse.json({
    automation,
    run,
    searchJob,
    campaign,
    mailboxSends: mailboxSends.map((m) => ({ mailboxId: m.mailboxId, count: m._count._all })),
  });
}