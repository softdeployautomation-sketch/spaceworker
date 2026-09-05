import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

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
    if (job.status !== "paused" || !job.resumeState) {
      return NextResponse.json({ error: "Job is not paused" }, { status: 400 });
    }
    // Re-queue through the SAME path a fresh job takes, rather than dispatching
    // to the worker directly from here. Dispatching directly would bypass Phase
    // A's advisory-lock + running-count check in app/api/internal/dispatch/route.ts
    // — the single-concurrent-job-per-lane guarantee that whole mechanism exists
    // to enforce — and could put two "running" jobs in one lane if something
    // else is mid-dispatch into this lane right now. Merge resumeState into
    // params (run_automation() already reads params.resumeState — see
    // worker/automation.py) so Phase A's existing dispatch body, unchanged,
    // carries it through automatically on its next tick.
    const paramsForResume = {
      ...(job.params as Record<string, unknown>),
      resumeState: job.resumeState,
    };
    await prisma.$transaction([
      prisma.searchJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          params: paramsForResume as Prisma.InputJsonValue,
          resumeState: Prisma.DbNull,
          workerJobId: null,
          error: null,
        },
      }),
      prisma.jobQueueEntry.update({
        where: { searchJobId: job.id },
        data: { status: "queued" },
      }),
    ]);
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
