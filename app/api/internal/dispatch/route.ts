import { NextResponse } from "next/server";
import { requireInternalBearer } from "@/lib/internal-auth";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resumeJob } from "@/lib/job-resume";
import { getAdminSettings } from "@/lib/admin-settings";
import { markDuplicateLeads } from "@/lib/lead-duplicates";
import {
  buildRejectRequeueData,
  buildWorkerCreateBody,
  classifyStuckJob,
  isWorkerMissing,
  planLaneDispatch,
  resolveLaneCaps,
} from "@/lib/dispatch-policy";
import {
  isPremiumTier,
  mayDispatchToolToday,
  recordTrialRun,
  toolForLane,
  trialDayKey,
} from "@/lib/trial";

const LANES = ["light", "heavy"] as const;

// Task 46 — admin admission control. Each lane's enabled/maxConcurrent now
// comes from AdminSetting instead of being hardcoded; defaults (enabled, max 1)
// match the previous hardcoded "running > 0" behavior exactly.
const LANE_SETTINGS_KEYS: Record<
  (typeof LANES)[number],
  { enabled: "dispatchLightEnabled" | "dispatchHeavyEnabled"; max: "dispatchLightMaxConcurrent" | "dispatchHeavyMaxConcurrent" }
> = {
  light: { enabled: "dispatchLightEnabled", max: "dispatchLightMaxConcurrent" },
  heavy: { enabled: "dispatchHeavyEnabled", max: "dispatchHeavyMaxConcurrent" },
};

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

// TASK_150 T2 — right after a batch is persisted, mark any address this user
// already had from an EARLIER session. Lead's uniqueness is per job, so that
// repeat is a second, legitimate-looking row the worker had no way to know
// about; without this the owner sees the same emails come back every session and
// "Validate emails" can never clear them (it only ever looks at its own job).
//
// Best-effort on purpose: the marker is idempotent and /validate re-runs it, so
// a failure here must NOT abort the tick — createMany above already succeeded,
// and throwing would skip finalizeJobAndMeter and leave a finished job stuck
// "running".
async function markSessionDuplicates(job: { userId: string }, leads: WorkerLead[]): Promise<void> {
  const emails = leads
    .map((l) => l.email)
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0);
  if (emails.length === 0) return;
  try {
    await markDuplicateLeads(prisma, { userId: job.userId, emails });
  } catch (err) {
    console.error("[dispatch] cross-session duplicate marking failed", err);
  }
}

// Stable integer IDs for PostgreSQL advisory locks — one per lane.
// pg_advisory_xact_lock holds the lock until the transaction commits/rolls
// back, so two concurrent dispatch calls for the same lane serialize
// rather than racing through the count+claim sequence.
const LANE_LOCK_ID: Record<string, number> = { light: 1001, heavy: 1002 };

export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workerBase = process.env.WORKER_BASE_URL;
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  const results: Record<string, unknown> = {};
  const adminSettings = await getAdminSettings();

  // TASK_168 Bug A — the stuck-`running` reaper runs FIRST, so a freed slot
  // is usable in this same tick. Two shapes, both pure-classified by
  // lib/dispatch-policy.ts `classifyStuckJob`:
  //   * `running` + no workerJobId + admitted >5min ago — dispatch claimed
  //     it but the worker POST never landed (worker down between the two
  //     writes, non-OK POST whose requeue write crashed). It never started,
  //     so it goes back to CLEAN `queued` (no resumeState — that column is
  //     only ever non-null while `paused`) and is retried, not billed.
  //   * `running` + workerJobId + no real step progress for 12h
  //     (currentStepAt only moves on a REAL step change, so a serialised
  //     job's stale step cannot look fresh) — the serialise-forever case
  //     from Bug A. Finished as failed via finalizeJobAndMeter so metering
  //     records what actually ran and the lane slot is freed.
  // (Hoisted metering finalizer — see the definition before the reaper.)

  const stuckReaped = { requeued: 0, failed: 0 };
  const stuckRunning = await prisma.searchJob.findMany({
    where: { status: "running" },
    select: {
      id: true, lane: true, workerJobId: true, trialStartedAt: true,
      createdAt: true, currentStep: true, currentStepAt: true, userId: true,
    },
  });
  const nowMs = Date.now();
  for (const stuck of stuckRunning) {
    const action = classifyStuckJob(stuck, nowMs);
    if (!action) continue;
    try {
      if (action === "requeue") {
        const clean = buildRejectRequeueData();
        await prisma.searchJob.update({
          where: { id: stuck.id },
          data: {
            status: clean.searchJob.status,
            workerJobId: clean.searchJob.workerJobId,
            error: clean.searchJob.error,
            trialStartedAt: clean.searchJob.trialStartedAt,
            resumeState: Prisma.DbNull,
          },
        });
        await prisma.jobQueueEntry.update({
          where: { searchJobId: stuck.id },
          data: { status: clean.queueEntry.status },
        });
        stuckReaped.requeued++;
      } else {
        await finalizeJobAndMeter(
          stuck as { id: string; userId: string; lane: string; trialStartedAt: Date | null },
          {
            status: "failed",
            error: "The job made no progress for 12 hours, so it was stopped to free its queue slot.",
          },
        );
        stuckReaped.failed++;
      }
    } catch {
      // Skip — will retry on the next tick rather than aborting admission.
    }
  }

  // TASK_168 Bug A — Phase A admits per lane WITHOUT cross-lane blocking.
  // Each lane's running count is weighed against its own cap, in a fixed
  // lane order, and a full (or off) lane X only pushes back X's own
  // candidates — head-of-line for X can never starve lane Y. Admission
  // order within a lane is queue order (priority desc, created asc); the
  // per-lane slice counts come from the shared pure helper
  // (lib/dispatch-policy.ts `planLaneDispatch`) so the route and its tests
  // read the same rule, and each lane still claims inside its own
  // advisory-locked transaction below.
  //
  // Contract item 2 (fairness): lane X full/busy/off NEVER skips lane Y's
  // candidates. Each lane gets its own plan slice from ONE shared fetch,
  // and the loop dispatches lane by lane — a failure claiming/posting for
  // X only records X's result key and moves on to Y.
  const caps = resolveLaneCaps(adminSettings as unknown as Record<string, unknown>);
  const queuedAll = await prisma.jobQueueEntry.findMany({
    where: { status: "queued", lane: { in: [...LANES] } },
    orderBy: [{ priorityTier: "desc" }, { createdAt: "asc" }],
    include: {
      searchJob: {
        select: { id: true, status: true, userId: true, query: true, params: true },
      },
    },
  });
  const runningByLane: Record<string, number> = {};
  for (const lane of LANES) {
    runningByLane[lane] = await prisma.searchJob.count({
      where: { lane, status: "running" },
    });
  }
  const plan = planLaneDispatch({ candidates: queuedAll, runningByLane, caps });
  results.phase_a_plan = {
    toDispatch: Object.fromEntries(
      LANES.map((lane) => [lane, plan.toDispatchByLane[lane].map((c) => c.searchJobId)]),
    ),
    pushBackCount: plan.pushBackCount,
    runningByLane,
    caps,
  };

  for (const lane of LANES) {
    const laneKeys = LANE_SETTINGS_KEYS[lane];
    // Task 46 — admin pause: existing running jobs keep running to
    // completion, only NEW claims stop. Checked before any transaction or
    // lock — a paused lane shouldn't even take the lock.
    if (!adminSettings[laneKeys.enabled]) {
      results[`${lane}_dispatch`] = "queue_paused";
      continue;
    }
    const toDispatch = plan.toDispatchByLane[lane];
    if (toDispatch.length === 0) {
      // Distinguish "nothing waiting" from "lane full": the pending count
      // here INCLUDES this lane's pushed-back rows, so "stuck at queued
      // with nothing actually processing" stays diagnosable.
      const pendingThisLane = queuedAll.filter((c) => c.lane === lane).length;
      results[`${lane}_dispatch`] = pendingThisLane > 0 ? "lane_busy" : "queue_empty";
      continue;
    }
    // Guard worker config ONCE per lane before touching the DB — avoids jobs
    // stuck "running" with no workerJobId when the env vars are missing.
    if (!workerBase || !workerToken) {
      results[`${lane}_dispatch`] = "no_worker_config";
      continue;
    }
    let laneOutcome: string = "queue_empty";
    let dispatchedCount = 0;
    for (const candidate of toDispatch) {
      // Id-keyed claim under the lane lock; re-checks running < cap inside.
      const claimed = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LANE_LOCK_ID[lane]})`;
        const running = await tx.searchJob.count({ where: { lane, status: "running" } });
        if (running >= caps[lane].maxConcurrent) return "lane_busy" as const;
        const entry = await tx.jobQueueEntry.findUnique({
          where: { id: candidate.id },
          include: {
            searchJob: {
              select: { id: true, status: true, userId: true, query: true, params: true },
            },
          },
        });
        if (!entry || entry.status !== "queued" || !entry.searchJob || entry.searchJob.status !== "queued") return null;
        const owner = await tx.user.findUnique({
          where: { id: entry.searchJob.userId },
          select: { tier: true },
        });
        const allow = await mayDispatchToolToday(tx, {
          userId: entry.searchJob.userId,
          tier: owner?.tier ?? 0,
          tool: toolForLane(lane),
          usedOn: trialDayKey(new Date()),
        });
        if (!allow) return "trial_cap" as const;
        const { count } = await tx.jobQueueEntry.updateMany({
          where: { id: entry.id, status: "queued" },
          data: { status: "dispatched" },
        });
        if (count === 0) return null;
        await tx.searchJob.update({
          where: { id: entry.searchJobId },
          data: { status: "running", trialStartedAt: new Date() },
        });
        return entry;
      });
      if (claimed === "lane_busy") {
        laneOutcome = dispatchedCount > 0 ? "dispatched_partial_lane_busy" : "lane_busy";
        break;
      }
      if (claimed === "trial_cap") {
        laneOutcome = dispatchedCount > 0 ? "dispatched_partial_trial_cap" : "trial_cap";
        break;
      }
      if (!claimed) continue;
      // Clean-requeue writer: the job never started, so back to CLEAN queued.
      const requeueClean = async () => {
        const clean = buildRejectRequeueData();
        await prisma.searchJob.update({
          where: { id: claimed.searchJobId },
          data: {
            status: clean.searchJob.status,
            workerJobId: clean.searchJob.workerJobId,
            error: clean.searchJob.error,
            trialStartedAt: clean.searchJob.trialStartedAt,
            resumeState: Prisma.DbNull,
          },
        }).catch(() => {});
        await prisma.jobQueueEntry.update({
          where: { searchJobId: claimed.searchJobId },
          data: { status: clean.queueEntry.status },
        }).catch(() => {});
      };
      const body = buildWorkerCreateBody({
        jobId: claimed.searchJob.id,
        lane,
        params: (claimed.searchJob.params ?? {}) as Record<string, unknown>,
        laneMaxConcurrent: caps[lane].maxConcurrent,
      });
      try {
        const res = await fetch(`${workerBase}/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerToken}`,
          },
          body: JSON.stringify({ ...body, query: claimed.searchJob.query }),
        });

        if (res.ok) {
          const data = (await res.json()) as { jobId?: string };
          if (!data.jobId) {
            // Worker returned 200 but no jobId — nothing to poll, so clean
            // requeue (NOT failed): the job never started.
            await requeueClean();
            laneOutcome = "worker_missing_jobid_requeued";
          } else {
            // The worker call above is a real network round trip — a
            // concurrent stop request could have cancelled this SearchJob
            // (status -> "stopped") in that exact window, before workerJobId
            // is ever recorded. Re-check status here and cancel the
            // just-started worker job instead of recording it as live.
            const current = await prisma.searchJob.findUnique({
              where: { id: claimed.searchJobId },
              select: { status: true },
            });
            if (current?.status !== "running") {
              laneOutcome = "cancelled_before_assign";
              void fetch(`${workerBase}/jobs/${data.jobId}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${workerToken}` },
              }).catch(() => {});
            } else {
              await safeUpdateSearchJob(claimed.searchJobId, { workerJobId: data.jobId });
              dispatchedCount++;
              laneOutcome = "dispatched";
            }
          }
        } else if (isWorkerMissing(res.status)) {
          // 404 on POST: the worker never saw the job — fail it via the
          // metered finalizer, same as Phase B's 404 path (contract item 5).
          await finalizeJobAndMeter(
            { id: claimed.searchJobId, userId: claimed.searchJob.userId, lane, trialStartedAt: new Date() },
            { status: "failed", error: "Worker has no record of this job (404)" },
          );
          laneOutcome = "worker_error_404";
        } else {
          // 409 lane-busy / 5xx: the worker refused — clean requeue so the
          // job retries on a later tick with no stale resume data.
          await requeueClean();
          laneOutcome = `worker_error_${res.status}_requeued`;
        }
      } catch {
        // POST threw (worker unreachable mid-claim) — clean requeue: the
        // job never started and must not hold its lane slot as `running`.
        await requeueClean();
        laneOutcome = "worker_unreachable_requeued";
      }
    }
    results[`${lane}_dispatch`] = laneOutcome;
    if (dispatchedCount > 0) results[`${lane}_dispatched_count`] = dispatchedCount;
  }

  // Tier 1 trial — finally-ize a run that reached a terminal state ("done",
  // "paused", "failed") in the SAME transaction that records its trial-usage
  // tally, so a crash between the two can't silently under-count a user's day.
  // Tolerant of a job deleted mid-poll (P2025), mirroring safeUpdateSearchJob.
  // Metering only ever applies to a non-Premium (trial) user and only when a
  // trialStartedAt dispatch marker is present (pre-deploy running jobs have
  // null and record nothing). Premium is exempt and never logged here.
  async function finalizeJobAndMeter(
    job: { id: string; userId: string; lane: string; trialStartedAt: Date | null },
    data: Parameters<typeof prisma.searchJob.update>[0]["data"],
  ): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.searchJob.update({ where: { id: job.id }, data });
        const owner = await tx.user.findUnique({
          where: { id: job.userId },
          select: { tier: true },
        });
        if (owner && !isPremiumTier(owner.tier) && job.trialStartedAt) {
          await recordTrialRun(tx, {
            userId: job.userId,
            tool: toolForLane(job.lane) ?? "extractor",
            lane: job.lane,
            elapsedSeconds: (Date.now() - job.trialStartedAt.getTime()) / 1000,
            usedOn: trialDayKey(job.trialStartedAt),
            jobId: job.id,
          });
        }
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return;
      throw err;
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
          // TASK_150 T2 — a new session must come back CLEAN: flag addresses the
          // user already has from an earlier session here, at persist time, not
          // only when the owner later clicks Validate.
          await markSessionDuplicates(job, data.leads);
        }
        await finalizeJobAndMeter(job, { status: "done" });
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
          await markSessionDuplicates(job, data.leads);
        }
        await finalizeJobAndMeter(job, {
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
        await finalizeJobAndMeter(job, { status: "failed", error: data.error ?? "Worker reported failure" });
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
          // Same mid-run persist as the done/paused branches above — a repeat of
          // an earlier session's address is marked while the job is still running,
          // not only once it finishes.
          await markSessionDuplicates(job, data.leads);
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
