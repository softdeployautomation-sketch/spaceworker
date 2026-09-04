import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";

// GET /api/admin/queue — every SearchJob with its queue entry (if any) and lead
// count, so a stall like "stuck at queued with nothing actually processing" is
// diagnosable from the admin panel instead of requiring direct DB/SSH access.
// This surfaces both halves of the pipeline: JobQueueEntry.status ("queued" |
// "dispatched") is the dispatcher's own claim state, while SearchJob.status
// ("queued" | "running" | "done" | "failed") is the job's real lifecycle —
// showing both together is what makes a stall (e.g. queue entry "dispatched"
// but SearchJob stuck "running" forever) actually diagnosable.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const jobs = await prisma.searchJob.findMany({
    include: {
      user: { select: { email: true } },
      queueEntry: { select: { status: true, priorityTier: true } },
      _count: { select: { leads: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json(
    jobs.map((j) => ({
      id: j.id,
      query: j.query,
      template: j.template,
      lane: j.lane,
      jobStatus: j.status,
      queueStatus: j.queueEntry?.status ?? null,
      priorityTier: j.queueEntry?.priorityTier ?? null,
      workerJobId: j.workerJobId,
      error: j.error,
      leadCount: j._count.leads,
      userEmail: j.user.email,
      createdAt: j.createdAt.toISOString(),
    }))
  );
}
