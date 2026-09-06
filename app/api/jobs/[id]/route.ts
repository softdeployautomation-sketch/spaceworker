import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { resumeJob } from "@/lib/job-resume";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    include: {
      leads: {
        select: {
          id: true, email: true, phone: true, contactName: true,
          businessName: true, website: true, sourceUrl: true, snippet: true, createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job);
}

// PATCH /api/jobs/[id] — resume-control for a Task 13 runnable job. Body:
// { action: "pause" | "resume" }.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  let body: { action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = body?.action;

  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workerBase = process.env.WORKER_BASE_URL;
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  if (!workerBase || !workerToken) {
    return NextResponse.json({ error: "Worker not configured" }, { status: 500 });
  }

  if (action === "pause") {
    // Only a genuinely running job (with a worker job to talk to) can be paused.
    if (job.status !== "running" || !job.workerJobId) {
      return NextResponse.json({ error: "Job is not running" }, { status: 400 });
    }
    try {
      const res = await fetch(`${workerBase}/jobs/${job.workerJobId}/pause`, {
        method: "POST",
        headers: { Authorization: `Bearer ${workerToken}` },
      });
      if (!res.ok) {
        return NextResponse.json({ error: `Worker rejected pause: ${res.status}` }, { status: 502 });
      }
    } catch {
      return NextResponse.json({ error: "Worker unreachable" }, { status: 502 });
    }
    // Optimistically return — the dispatcher's next poll tick turns the job
    // "paused" and persists the leads found so far. We do NOT wait here for the
    // worker to finish its in-flight query (that could take a while).
    return NextResponse.json({ ok: true });
  }

  if (action === "resume") {
    // Shared with the dispatcher's Phase C auto-resume (outage-paused jobs) —
    // see lib/job-resume.ts for why this MUST be the same compare-and-swap
    // helper rather than two independent re-queue transactions: a human
    // clicking Resume right as an outage cooldown elapses is a real race
    // between this route and Phase C, and only a CAS on status="paused"
    // prevents one of them from silently reverting an already-running job.
    const outcome = await resumeJob(job.id);
    if (outcome === "not_paused") {
      return NextResponse.json({ error: "Job is not paused" }, { status: 400 });
    }
    // "already_handled" (Phase C's auto-resume won the race a moment ago) is
    // still a success from this caller's point of view — the job is resumed
    // either way, just not because of THIS specific request.
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: `Unknown action: ${String(action ?? "")}` },
    { status: 400 }
  );
}

// DELETE /api/jobs/[id] — removes a job run and its leads/queue entry from the
// list. Blocked while "running" (stop it first) so a delete can't orphan an
// in-flight worker job with nothing left to poll or clean it up.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({ where: { id, userId: session.userId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.status === "running") {
    return NextResponse.json({ error: "Stop the job before deleting it." }, { status: 409 });
  }

  // A "paused" job still has a live entry in the worker's in-memory registry
  // (its leads/resumeState) under job.workerJobId — tell it to forget the job
  // rather than leaving that to the 1hr TTL prune. Best-effort: the DB delete
  // below is what actually matters to the user, so a worker that's briefly
  // unreachable shouldn't block it.
  if (job.status === "paused" && job.workerJobId && process.env.WORKER_BASE_URL) {
    void fetch(`${process.env.WORKER_BASE_URL}/jobs/${job.workerJobId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.WORKER_AUTH_TOKEN}` },
    }).catch(() => {});
  }

  // No onDelete: Cascade on JobQueueEntry/Lead -> SearchJob, so delete children
  // first inside one transaction (all-or-nothing, avoids an FK error leaving
  // a half-deleted job).
  await prisma.$transaction([
    prisma.jobQueueEntry.deleteMany({ where: { searchJobId: id } }),
    prisma.lead.deleteMany({ where: { searchJobId: id } }),
    prisma.searchJob.delete({ where: { id } }),
  ]);

  return NextResponse.json({ ok: true });
}
