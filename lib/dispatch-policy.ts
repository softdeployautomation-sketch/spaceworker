// TASK_168 Bug A — pure dispatch policy helpers.
//
// WHY THIS FILE EXISTS: the queue P0 ("dial says 3, only 1 gets results")
// spans three coupled behaviours — per-lane admission fairness, the
// worker-reject requeue shape, and the stuck-`running` slot bound — that
// previously lived inline in app/api/internal/dispatch/route.ts where no
// test could touch them without a database. The route stays the only place
// that READS/WRITES rows; everything DECIDED about those rows lives here as
// pure functions, so tests/dispatch-queue.test.ts proves the contracts
// directly against this file (never a copy of its logic).

export const DISPATCH_LANES = ["light", "heavy"] as const;
export type DispatchLane = (typeof DISPATCH_LANES)[number];

export interface LaneCap {
  enabled: boolean;
  maxConcurrent: number;
}

export type LaneCaps = Record<DispatchLane, LaneCap>;

/**
 * Resolve each lane's admission gate from the AdminSetting row.
 *
 * Defaults match the schema exactly (enabled, max 1) so a missing row or a
 * half-written value reproduces the pre-TASK_46 "running > 0" behaviour
 * instead of wedging a lane open or shut. Non-finite / sub-1 maxima clamp
 * to 1 — a cap of 0 would mean "enabled but never dispatch".
 */
export function resolveLaneCaps(adminSettings: Record<string, unknown>): LaneCaps {
  const pick = (enabledKey: string, maxKey: string): LaneCap => {
    const enabledRaw = adminSettings[enabledKey];
    const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;
    const maxRaw = adminSettings[maxKey];
    const maxConcurrent =
      typeof maxRaw === "number" && Number.isFinite(maxRaw)
        ? Math.max(1, Math.floor(maxRaw))
        : 1;
    return { enabled, maxConcurrent };
  };
  return {
    light: pick("dispatchLightEnabled", "dispatchLightMaxConcurrent"),
    heavy: pick("dispatchHeavyEnabled", "dispatchHeavyMaxConcurrent"),
  };
}

export interface QueueCandidate {
  id: string;
  searchJobId: string;
  lane: string;
}

export interface LaneDispatchPlan {
  /** Candidates to ATTEMPT this tick, per lane (still claimed one-by-one). */
  toDispatchByLane: Record<DispatchLane, QueueCandidate[]>;
  /** Candidates skipped because their lane is off or full. */
  pushBackCount: number;
}

/**
 * Plan one tick's Phase A admission WITHOUT cross-lane blocking.
 *
 * Each lane is decided independently from its own running count and cap, in
 * a fixed lane order — a full (or disabled) lane X only pushes back X's own
 * candidates and can never consume or starve lane Y's slots. Within a lane
 * the queue order is preserved (take the first `slots` candidates).
 */
export function planLaneDispatch(args: {
  candidates: QueueCandidate[];
  runningByLane: Record<string, number>;
  caps: LaneCaps;
}): LaneDispatchPlan {
  const toDispatchByLane: Record<DispatchLane, QueueCandidate[]> = {
    light: [],
    heavy: [],
  };
  let pushBackCount = 0;
  for (const lane of DISPATCH_LANES) {
    const cap = args.caps[lane];
    const inLane = args.candidates.filter((c) => c.lane === lane);
    if (!cap.enabled) {
      pushBackCount += inLane.length;
      continue;
    }
    const running = args.runningByLane[lane] ?? 0;
    const slots = cap.maxConcurrent - running;
    if (slots <= 0) {
      pushBackCount += inLane.length;
      continue;
    }
    toDispatchByLane[lane] = inLane.slice(0, slots);
    pushBackCount += inLane.length - toDispatchByLane[lane].length;
  }
  return { toDispatchByLane, pushBackCount };
}

export interface RejectRequeueData {
  /** Data for the SearchJob update — a CLEAN `queued` row. */
  searchJob: {
    status: "queued";
    workerJobId: null;
    error: null;
    trialStartedAt: null;
    /** True => the route must write Prisma.DbNull into resumeState. */
    clearResumeState: true;
  };
  /** Data for the JobQueueEntry update. */
  queueEntry: { status: "queued" };
}

/**
 * The shape of a worker-rejected requeue.
 *
 * A job the worker refused (409 lane busy, 5xx, or the POST threw) never
 * started, so it must go back to `queued` holding NOTHING: no workerJobId
 * to poll, no error text (it will retry; an error would read as a failure),
 * no trialStartedAt (the next admission stamps a fresh metering window),
 * no resumeState column (that column is only ever non-null while `paused`),
 * and its queue entry back to `queued` so Phase A can see it again. Leaving
 * any of these behind is exactly the "stuck running forever, holding its
 * lane slot" wedging the owner reported.
 */
export function buildRejectRequeueData(): RejectRequeueData {
  return {
    searchJob: {
      status: "queued",
      workerJobId: null,
      error: null,
      trialStartedAt: null,
      clearResumeState: true,
    },
    queueEntry: { status: "queued" },
  };
}

export interface RunningJobSnapshot {
  id: string;
  lane: string;
  workerJobId: string | null;
  trialStartedAt: Date | null;
  createdAt: Date;
  currentStep: string | null;
  currentStepAt: Date | null;
}

export type StuckJobAction = "requeue" | "fail";

/** A `running` row with no workerJobId never started — retry it, don't bill it. */
export const STUCK_NO_WORKER_REQUEUE_MS = 5 * 60 * 1000;
/** A started job with no real step progress for this long is dead — free its slot. */
export const STUCK_NO_PROGRESS_FAIL_MS = 12 * 60 * 60 * 1000;

/**
 * Classify one `running` row for the stuck-slot reaper (runs before Phase A
 * admission each tick, so a freed slot is usable in the SAME tick).
 *
 *   * workerJobId null + admitted longer than STUCK_NO_WORKER_REQUEUE_MS ago
 *     => "requeue" (clean, via buildRejectRequeueData).
 *   * workerJobId set + no real progress (currentStepAt, else trialStartedAt,
 *     else createdAt) for longer than STUCK_NO_PROGRESS_FAIL_MS
 *     => "fail" (finalizeJobAndMeter, freeing the lane).
 *   * otherwise => null (leave it alone).
 *
 * trialStartedAt is null for pre-deploy rows, so createdAt is the fallback —
 * never "null means stuck" (that would massacre a just-admitted job).
 */
export function classifyStuckJob(job: RunningJobSnapshot, nowMs: number): StuckJobAction | null {
  if (!job.workerJobId) {
    const admittedAtMs = (job.trialStartedAt ?? job.createdAt).getTime();
    return nowMs - admittedAtMs > STUCK_NO_WORKER_REQUEUE_MS ? "requeue" : null;
  }
  const progressAtMs = (job.currentStepAt ?? job.trialStartedAt ?? job.createdAt).getTime();
  return nowMs - progressAtMs > STUCK_NO_PROGRESS_FAIL_MS ? "fail" : null;
}

/**
 * The worker's per-lane cap hint the dispatcher sends on every POST /jobs.
 * The worker adopts a valid hint as its live cap (growing AND shrinking),
 * so the admin dial flows dispatcher -> worker with no second config and no
 * restart; without a hint the worker keeps its env/startup value.
 */
export function buildWorkerCreateBody(args: {
  jobId: string;
  lane: string;
  params: Record<string, unknown>;
  laneMaxConcurrent: number;
}): { jobId: string; lane: string; params: Record<string, unknown>; laneMaxConcurrent: number } {
  return {
    jobId: args.jobId,
    lane: args.lane,
    params: args.params,
    laneMaxConcurrent: args.laneMaxConcurrent,
  };
}

/** A worker 404 means it never saw / already forgot the job — fail it, keep it failed. */
export function isWorkerMissing(httpStatus: number): boolean {
  return httpStatus === 404;
}
