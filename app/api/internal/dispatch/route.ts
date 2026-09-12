import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resumeJob } from "@/lib/job-resume";

const LANES = ["light", "heavy"] as const;

// A job can be deleted (DELETE /api/jobs/[id]) in the window between this
// route claiming/dispatching it and a later update in an error-handling
// path — Prisma throws P2025 ("record not found") for an update against a
// row that's gone. That's a genuinely benign race here (nothing left to
// update), not a real fault — swallowing it stops one job's mid-flight
// deletion from throwing out of this whole dispatch tick and skipping every
// other lane's dispatch + all of phase B's polling for that cycle.
async function safeUpdateSearchJob(id: string, data: Parameters<typeof prisma.searchJob.update>[0]["data"]): Promise<void> {
  try {
    await prisma.searchJob.update({ where: { id }, data });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return;
    throw err;
  }
}

interface WorkerLead {
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  businessName?: string | null;
  website?: string | null;
  sourceUrl?: string | null;
  snippet?: string | null;
}

// Shared Lead-row mapping used by BOTH the "done" and "paused" Phase B branches —
// keeps the two persistence paths identical instead of copy-pasting the mapping.
function buildLeadRows(job: { userId: string; id: string }, leads: WorkerLead[]) {
  return leads.map((l) => ({
    userId: job.userId,
    searchJobId: job.id,
    email: l.email ?? null,
    phone: l.phone ?? null,
    contactName: l.contactName ?? null,
    businessName: l.businessName ?? null,
    website: l.website ?? null,
    sourceUrl: l.sourceUrl ?? null,
    snippet: l.snippet ?? null,
  }));
}

// Stable integer IDs for PostgreSQL advisory locks — one per lane.
// pg_advisory_xact_lock holds the lock until the transaction commits/rolls
// back, so two concurrent dispatch calls for the same lane serialize
// rather than racing through the count+claim sequence.
const LANE_LOCK_ID: Record<string, number> = { light: 1001, heavy: 1002 };

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workerBase = process.env.WORKER_BASE_URL;
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  const results: Record<string, unknown> = {};

  // Phase A: dispatch one queued job per idle lane
  for (const lane of LANES) {
    // Guard worker config before touching the DB — avoids jobs stuck "running"
    // with no workerJobId when the env vars are missing.
    if (!workerBase || !workerToken) {
      results[`${lane}_dispatch`] = "no_worker_config";
      continue;
    }

    // The lane-busy count and the row claim are inside one transaction guarded
    // by a PostgreSQL advisory lock. This prevents two concurrent dispatch
    // calls from each seeing running=0 independently and then each claiming a
    // different queued entry — which would violate the single-concurrency
    // invariant for each lane.
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LANE_LOCK_ID[lane]})`;

      const running = await tx.searchJob.count({ where: { lane, status: "running" } });
      if (running > 0) return "lane_busy" as const;

      const entry = await tx.jobQueueEntry.findFirst({
        where: { lane, status: "queued" },
        orderBy: [{ priorityTier: "desc" }, { createdAt: "asc" }],
        include: { searchJob: true },
      });
      if (!entry) return null;

      const { count } = await tx.jobQueueEntry.updateMany({
        where: { id: entry.id, status: "queued" },
        data: { status: "dispatched" },
      });
      if (count === 0) return null;

      await tx.searchJob.update({
        where: { id: entry.searchJobId },
        data: { status: "running" },
      });
      return entry;
    });

    if (claimed === "lane_busy") {
      results[`${lane}_dispatch`] = "lane_busy";
      continue;
    }

    if (!claimed) {
      results[`${lane}_dispatch`] = "queue_empty";
      continue;
    }

    try {
      const res = await fetch(`${workerBase}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          jobId: claimed.searchJob.id,
          query: claimed.searchJob.query,
          params: claimed.searchJob.params,
          lane,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { jobId?: string };
        if (!data.jobId) {
          // Worker returned 200 but no jobId — treat as failure so the job
          // doesn't get stuck "running" forever with nothing to poll.
          await safeUpdateSearchJob(claimed.searchJobId, { status: "failed", error: "Worker returned no jobId" });
          results[`${lane}_dispatch`] = "worker_missing_jobid";
        } else {
          // The worker call above is a real network round trip — a concurrent
          // stop request could have cancelled this SearchJob (status ->
          // "stopped") in that exact window, before workerJobId is ever
          // recorded. If that happened, the stop route's own DELETE call
          // already ran and found no workerJobId to cancel against, so the
          // worker is now running a job nobody can reach — re-check status
          // here, right before recording workerJobId, and immediately cancel
          // the just-started worker job instead of recording it as live.
          const current = await prisma.searchJob.findUnique({
            where: { id: claimed.searchJobId },
            select: { status: true },
          });
          if (current?.status !== "running") {
            results[`${lane}_dispatch`] = "cancelled_before_assign";
            void fetch(`${workerBase}/jobs/${data.jobId}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${workerToken}` },
            }).catch(() => {});
          } else {
            await safeUpdateSearchJob(claimed.searchJobId, { workerJobId: data.jobId });
            results[`${lane}_dispatch`] = "dispatched";
          }
        }
      } else {
        await safeUpdateSearchJob(claimed.searchJobId, { status: "failed", error: `Worker rejected: ${res.status}` });
        results[`${lane}_dispatch`] = `worker_error_${res.status}`;
      }
    } catch (err) {
      await safeUpdateSearchJob(claimed.searchJobId, { status: "failed", error: String(err) });
      results[`${lane}_dispatch`] = "worker_unreachable";
    }
  }

  // Phase B: poll running jobs for completion
  const runningJobs = await prisma.searchJob.findMany({
    where: { status: "running", workerJobId: { not: null } },
  });

  let completed = 0;
  let failed = 0;
  let paused = 0;
  let liveUpdated = 0;

  for (const job of runningJobs) {
    if (!workerBase || !workerToken || !job.workerJobId) continue;

    try {
      const res = await fetch(`${workerBase}/jobs/${job.workerJobId}`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        status?: string;
        leads?: WorkerLead[];
        error?: string;
        resumeState?: unknown;
        currentStep?: string | null;
      };

      if (data.status === "done") {
        if (Array.isArray(data.leads) && data.leads.length > 0) {
          await prisma.lead.createMany({
            data: buildLeadRows(job, data.leads),
            skipDuplicates: true,
          });
        }
        await prisma.searchJob.update({
          where: { id: job.id },
          data: { status: "done" },
        });
        completed++;
      } else if (data.status === "paused") {
        // Task 13 resume: the worker stopped at a query boundary (manual pause or
        // max-duration cap). Persist everything found so far with the SAME lead
        // mapping as "done", then record the resumeState so a later resume can
        // pick up where it left off instead of restarting from query #1.
        if (Array.isArray(data.leads) && data.leads.length > 0) {
          await prisma.lead.createMany({
            data: buildLeadRows(job, data.leads),
            skipDuplicates: true,
          });
        }
        await safeUpdateSearchJob(job.id, {
          status: "paused",
          pausedAt: new Date(),
          resumeState: data.resumeState != null && data.resumeState !== undefined
            ? (data.resumeState as Prisma.InputJsonValue)
            : Prisma.DbNull,
        });
        // Now that the leads/resumeState are safely in Postgres, tell the
        // worker to forget this job rather than waiting on its 1hr TTL prune.
        // This matters beyond memory hygiene: Phase A always dispatches with
        // jobId == SearchJob.id (first run or resumed), so a stale paused
        // entry still sitting in the worker's JOBS under that same id would
        // make a later resume's re-dispatch 409 ("jobId already exists").
        void fetch(`${workerBase}/jobs/${job.workerJobId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${workerToken}` },
        }).catch(() => {});
        paused++;
      } else if (data.status === "failed") {
        await prisma.searchJob.update({
          where: { id: job.id },
          data: { status: "failed", error: data.error ?? "Worker reported failure" },
        });
        failed++;
      } else {
        // Still "running" — the worker's on_progress callback (worker/api.py)
        // already accumulates leads in memory as it finds them, and GET
        // /jobs/{id} returns them regardless of status; previously they only
        // reached Postgres once the job fully finished, so the extract page's
        // live count showed nothing until the very end even on a long,
        // multi-page/PDF crawl. Persist what's been found so far on every
        // tick instead — skipDuplicates (Lead's [searchJobId, sourceUrl, email]
        // unique constraint — widened from [searchJobId, sourceUrl] alone,
        // which silently capped every page/PDF at ONE saved lead regardless
        // of how many distinct emails it actually contained, see Task 25)
        // makes this a safe no-op for leads already inserted on a previous
        // tick, so it's cheap to call every ~10s.
        if (Array.isArray(data.leads) && data.leads.length > 0) {
          await prisma.lead.createMany({
            data: buildLeadRows(job, data.leads),
            skipDuplicates: true,
          });
        }
        // Task 14 live activity feed — persist the current step (also on ticks
        // where no lead was added, so a zero-lead-so-far job still shows what
        // it's doing). safeUpdateSearchJob (P2025-tolerant) so a job deleted
        // mid-tick can't throw out of this whole poll loop. This is the SAME
        // running branch as the lead createMany above — not a duplicate branch.
        //
        // Known limitation: results extract concurrently (asyncio.gather in
        // _search_and_extract), so multiple on_step reports can race to
        // overwrite state.current_step worker-side before this tick ever
        // reads it — the URL shown here can be an arbitrary one of the batch,
        // not necessarily the "last" one. Harmless (display-only, no effect
        // on which leads get saved), just not fully deterministic.
        // NOTE: this is the only branch that writes currentStep; the
        // done/paused/failed branches below deliberately do NOT clear it, so
        // the last-known step ("where did it get to") stays visible after the
        // job stops rather than being wiped to null.
        //
        // Task 15 stall detection: currentStepAt only moves forward when the
        // step text actually changed from what's already stored (`job` here
        // is the pre-tick row fetched above, so job.currentStep is the prior
        // value) -- re-stamping it on every tick regardless of content would
        // make a genuinely stuck job (same step, tick after tick) look fresh
        // forever, which is exactly the case this exists to catch.
        const nextStep = data.currentStep ?? null;
        await safeUpdateSearchJob(job.id, {
          currentStep: nextStep,
          ...(nextStep !== job.currentStep ? { currentStepAt: new Date() } : {}),
        });
        liveUpdated++;
      }
    } catch {
      // Skip — will retry on next tick
    }
  }

  results.phase_b = { completed, failed, paused, liveUpdated, checked: runningJobs.length };

  // Phase C: auto-resume jobs paused because the search engine looked down
  // (worker/automation.py's consecutive-failure-pause — resumeState.pauseReason
  // === "outage"), once a cooldown has passed. A manual pause or the duration
  // cap ALSO leave status "paused", but those are the user's own deliberate
  // stop and must never be silently resumed — only "outage" is safe to retry
  // without a human looking at it, matching "pause when the server is down,
  // continue when it's up" rather than sitting there forever waiting for
  // someone to notice and click Resume.
  //
  // Uses the SAME resumeJob() the manual-resume PATCH route uses (not a second
  // independent re-queue transaction) — a human clicking Resume right as this
  // cooldown elapses is a real race, and only sharing one compare-and-swap
  // helper (status="paused" guard) prevents one of the two callers from
  // reverting an already-running job back to "queued" out from under the other.
  //
  // Capped via outageResumeCount: this VPS's Google egress is a CONFIRMED
  // durable block (see worker/automation.py's CAPTCHA notes), not a transient
  // one — without a cap, a job stuck against a durable block would auto-resume
  // forever, repeatedly consuming its lane's only concurrency slot. After the
  // cap it just stays "paused" for a human to look at.
  const OUTAGE_RESUME_COOLDOWN_MS = 5 * 60 * 1000;
  const MAX_OUTAGE_AUTO_RESUMES = 5;
  let autoResumed = 0;
  const cooldownCutoff = new Date(Date.now() - OUTAGE_RESUME_COOLDOWN_MS);
  const candidates = await prisma.searchJob.findMany({
    where: {
      status: "paused",
      pausedAt: { lte: cooldownCutoff },
      outageResumeCount: { lt: MAX_OUTAGE_AUTO_RESUMES },
    },
  });
  for (const job of candidates) {
    const resumeState = job.resumeState as { pauseReason?: string } | null;
    if (!resumeState || resumeState.pauseReason !== "outage") continue;
    try {
      const outcome = await resumeJob(job.id);
      if (outcome === "resumed") {
        // Best-effort, separate from the CAS transaction itself — an
        // undercount here in a rare race is low-stakes (one fewer retry
        // counted, never a correctness issue for the job's own data).
        await prisma.searchJob.update({
          where: { id: job.id },
          data: { outageResumeCount: { increment: 1 } },
        }).catch(() => {});
        autoResumed++;
      }
    } catch {
      // Skip — will retry on a later tick rather than aborting this whole phase
    }
  }
  results.phase_c = { autoResumed, candidates: candidates.length };

  return NextResponse.json(results);
}
