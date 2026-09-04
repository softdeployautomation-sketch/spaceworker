import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
  });

  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (job.status !== "queued" && job.status !== "running") {
    return NextResponse.json({ error: "Job is not stoppable" }, { status: 400 });
  }

  // Cancel both the job and its queue entry atomically. Use "cancelled" (not
  // "dispatched") so callers can distinguish manually-cancelled entries from
  // entries that were genuinely sent to the worker.
  await prisma.$transaction([
    prisma.searchJob.update({
      where: { id },
      data: { status: "failed", error: "Cancelled by user" },
    }),
    prisma.jobQueueEntry.updateMany({
      where: { searchJobId: id, status: "queued" },
      data: { status: "cancelled" },
    }),
  ]);

  // Re-read workerJobId AFTER the transaction. The dispatcher may have set it
  // in the window between our initial findFirst and the transaction committing,
  // so using the pre-transaction value could leave the worker running orphaned.
  const fresh = await prisma.searchJob.findUnique({
    where: { id },
    select: { workerJobId: true },
  });
  if (fresh?.workerJobId && process.env.WORKER_BASE_URL) {
    try {
      await fetch(`${process.env.WORKER_BASE_URL}/jobs/${fresh.workerJobId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${process.env.WORKER_AUTH_TOKEN}` },
      });
    } catch {
      // Worker unreachable — DB already marks it stopped, acceptable
    }
  }

  return NextResponse.json({ ok: true });
}
