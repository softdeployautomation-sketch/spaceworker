import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ResumeOutcome = "resumed" | "already_handled" | "not_paused";

/**
 * Re-queues a paused SearchJob through the exact path a fresh job takes,
 * rather than dispatching to the worker directly — that would bypass Phase
 * A's advisory-lock + running-count check (app/api/internal/dispatch/route.ts),
 * the single-concurrent-job-per-lane guarantee that whole mechanism exists to
 * enforce.
 *
 * Shared by BOTH the manual resume PATCH route and the dispatcher's Phase C
 * auto-resume (outage-paused jobs) specifically because they can race: a
 * human clicking Resume right as an outage cooldown elapses could otherwise
 * have both callers build a re-queue transaction from the same stale
 * "paused" read, and whichever committed second would silently revert an
 * already-running job back to "queued" — orphaning the live worker execution
 * (which a later dispatch tick then collides with via create_job's "jobId
 * already exists" 409). The updateMany's `status: "paused"` guard is a
 * compare-and-swap: only the FIRST caller to actually commit while the row is
 * still "paused" wins; a second, racing caller sees `count === 0` and backs
 * off as "already_handled" instead of corrupting the row.
 */
export async function resumeJob(jobId: string): Promise<ResumeOutcome> {
  const job = await prisma.searchJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "paused" || !job.resumeState) return "not_paused";

  const paramsForResume = {
    ...(job.params as Record<string, unknown>),
    resumeState: job.resumeState,
  };

  const claimed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.searchJob.updateMany({
      where: { id: jobId, status: "paused" },
      data: {
        status: "queued",
        params: paramsForResume as Prisma.InputJsonValue,
        resumeState: Prisma.DbNull,
        pausedAt: null,
        workerJobId: null,
        error: null,
      },
    });
    if (count === 0) return false;
    await tx.jobQueueEntry.update({
      where: { searchJobId: jobId },
      data: { status: "queued" },
    });
    return true;
  });

  return claimed ? "resumed" : "already_handled";
}
