import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Task 26, Piece 7d — 30-day SearchJob auto-deletion policy.
// POST /api/internal/retention-sweep, gated by the same INTERNAL_BEARER_TOKEN as the
// other internal routes; meant to be hit by the external scheduler on a long interval
// (e.g. once a day) — a sibling of app/api/internal/dispatch, not new infrastructure.
//
// Conservative policy (confirmed with the user 2026-09-12): a SearchJob and ALL its
// leads are only swept when EVERY condition holds —
//   1. older than 30 days (createdAt before the cutoff), AND
//   2. status is a terminal one ("done" or "stopped" — never running/paused/queued,
//      and not "failed", so that state's leads are kept too), AND
//   3. none of its leads' emails have EVER been used in a campaign, matched via
//      EmailQueueItem.toEmail — the only signal we have that a lead was actually
//      used in the mail pipeline.
// Anything else is left alone even when old: silently deleting a lead the user is
// actively relying on would be a data-loss bug, not a cleanup.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const candidates = await prisma.searchJob.findMany({
    where: {
      status: { in: ["done", "stopped"] },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
  });

  const deletable: string[] = [];
  for (const job of candidates) {
    const leads = await prisma.lead.findMany({
      where: { searchJobId: job.id },
      select: { email: true },
    });
    const emails = leads.map((l) => l.email).filter((e): e is string => !!e && e.trim().length > 0);
    if (emails.length === 0) {
      deletable.push(job.id);
      continue;
    }
    const used = await prisma.emailQueueItem.findFirst({
      where: { toEmail: { in: emails } },
      select: { id: true },
    });
    if (!used) deletable.push(job.id);
  }

  if (deletable.length > 0) {
    // Lead and JobQueueEntry reference the job via required FKs with no onDelete
    // action, so drop both before the job itself — all in one transaction.
    await prisma.$transaction([
      prisma.lead.deleteMany({ where: { searchJobId: { in: deletable } } }),
      prisma.jobQueueEntry.deleteMany({ where: { searchJobId: { in: deletable } } }),
      prisma.searchJob.deleteMany({ where: { id: { in: deletable } } }),
    ]);
  }

  // Traceable enough to spot a surprising sweep after the fact without burning the
  // whole day: how many jobs were removed plus a sample of their ids. (console.log
  // is this app's lightweight logging convention — see app/api for other usages.)
  const sample = deletable.slice(0, 20).join(", ");
  console.log(`[retention-sweep] swept ${deletable.length} job(s) older than 30d; sample ids: ${sample || "(none)"}`);

  return NextResponse.json({ swept: deletable.length, sampledIds: deletable.slice(0, 20) });
}