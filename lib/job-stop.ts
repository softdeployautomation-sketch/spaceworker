import "server-only";
import { prisma } from "./prisma";

// Shared per-job cancellation used by BOTH the customer-facing stop route
// (app/api/jobs/[id]/stop/route.ts) and the admin stop route
// (app/api/admin/queue/[id]/stop/route.ts), so the two callers can't silently
// drift apart. The customer route additionally enforces ownership (findFirst
// scoped to session.userId) BEFORE calling this; the admin route calls it
// straight after requireAdminSession(). The helper itself is deliberately
// user-agnostic — it never filters by owner — so admin stays able to stop any
// customer's job.

export type StopSearchJobResult =
  | { outcome: "stopped" }
  | { outcome: "not_found" }
  | { outcome: "not_stoppable" };

export async function stopSearchJob(id: string): Promise<StopSearchJobResult> {
  const job = await prisma.searchJob.findUnique({ where: { id } });
  if (!job) return { outcome: "not_found" };
  if (job.status !== "queued" && job.status !== "running") {
    return { outcome: "not_stoppable" };
  }

  // Cancel both the job and its queue entry atomically. Use "cancelled" (not
  // "dispatched") so callers can distinguish manually-cancelled entries from
  // entries that were genuinely sent to the worker.
  //
  // "stopped" is deliberately distinct from "failed" -- a user/admin clicking
  // Stop is not an error, and showing it as one (as this used to) made every
  // manually-stopped job look like a crash.
  await prisma.$transaction([
    prisma.searchJob.update({
      where: { id },
      data: { status: "stopped", error: null },
    }),
    prisma.jobQueueEntry.updateMany({
      where: { searchJobId: id, status: "queued" },
      data: { status: "cancelled" },
    }),
  ]);

  // Re-read workerJobId AFTER the transaction. The dispatcher may have set it
  // in the window between our initial read and the transaction committing, so
  // using the pre-transaction value could leave the worker running orphaned.
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

  return { outcome: "stopped" };
}