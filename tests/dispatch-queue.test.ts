// TASK_168 Bug A — dispatch-queue policy contracts.
//
// WHY THIS FILE EXISTS: the queue P0 ("dial says 3, only 1 gets results")
// spans three coupled behaviours that previously lived inline in
// app/api/internal/dispatch/route.ts where no test could touch them without
// a database. The route reads/writes rows; everything DECIDED about those
// rows lives in lib/dispatch-policy.ts as pure functions, and THIS file
// proves those contracts directly against that file (never a copy of its
// logic): per-lane admission fairness, the clean worker-reject requeue
// shape, the stuck-`running` slot bound, and the worker create-body hint.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRejectRequeueData,
  buildWorkerCreateBody,
  classifyStuckJob,
  isWorkerMissing,
  planLaneDispatch,
  resolveLaneCaps,
  STUCK_NO_PROGRESS_FAIL_MS,
  STUCK_NO_WORKER_REQUEUE_MS,
} from "../lib/dispatch-policy";

test("lane caps resolve from the admin dial, defaulting to enabled/1", () => {
  assert.deepEqual(
    resolveLaneCaps({ dispatchLightEnabled: true, dispatchLightMaxConcurrent: 3 }),
    { light: { enabled: true, maxConcurrent: 3 }, heavy: { enabled: true, maxConcurrent: 1 } },
  );
});

test("lane caps clamp nonsense instead of wedging a lane open or shut", () => {
  const caps = resolveLaneCaps({
    dispatchLightEnabled: true,
    dispatchLightMaxConcurrent: 0,
    dispatchHeavyEnabled: false,
    dispatchHeavyMaxConcurrent: NaN,
  });
  assert.equal(caps.light.maxConcurrent, 1);
  assert.equal(caps.heavy.enabled, false);
  assert.equal(caps.heavy.maxConcurrent, 1);
});

test("a full light lane does not block a healthy heavy lane", () => {
  const plan = planLaneDispatch({
    candidates: [
      { id: "q1", searchJobId: "j1", lane: "light" },
      { id: "q2", searchJobId: "j2", lane: "heavy" },
    ],
    runningByLane: { light: 3, heavy: 0 },
    caps: {
      light: { enabled: true, maxConcurrent: 3 },
      heavy: { enabled: true, maxConcurrent: 3 },
    },
  });
  assert.deepEqual(plan.toDispatchByLane.light, []);
  assert.deepEqual(plan.toDispatchByLane.heavy, [{ id: "q2", searchJobId: "j2", lane: "heavy" }]);
  assert.equal(plan.pushBackCount, 1);
});

test("a disabled lane pushes back only its own candidates", () => {
  const plan = planLaneDispatch({
    candidates: [
      { id: "q1", searchJobId: "j1", lane: "light" },
      { id: "q2", searchJobId: "j2", lane: "heavy" },
    ],
    runningByLane: { light: 0, heavy: 0 },
    caps: {
      light: { enabled: false, maxConcurrent: 3 },
      heavy: { enabled: true, maxConcurrent: 3 },
    },
  });
  assert.deepEqual(plan.toDispatchByLane.light, []);
  assert.equal(plan.toDispatchByLane.heavy.length, 1);
});

test("admission within a lane takes queue order up to its free slots", () => {
  const plan = planLaneDispatch({
    candidates: [
      { id: "q1", searchJobId: "j1", lane: "heavy" },
      { id: "q2", searchJobId: "j2", lane: "heavy" },
      { id: "q3", searchJobId: "j3", lane: "heavy" },
    ],
    runningByLane: { light: 0, heavy: 1 },
    caps: {
      light: { enabled: true, maxConcurrent: 3 },
      heavy: { enabled: true, maxConcurrent: 3 },
    },
  });
  assert.deepEqual(plan.toDispatchByLane.heavy.map((c) => c.id), ["q1", "q2"]);
  assert.equal(plan.pushBackCount, 1);
});

test("a worker-rejected job requeues holding nothing (no slot wedge)", () => {
  const clean = buildRejectRequeueData();
  assert.equal(clean.searchJob.status, "queued");
  assert.equal(clean.searchJob.workerJobId, null);
  assert.equal(clean.searchJob.error, null);
  assert.equal(clean.searchJob.trialStartedAt, null);
  assert.equal(clean.searchJob.clearResumeState, true);
  assert.equal(clean.queueEntry.status, "queued");
});

test("running with no workerJobId past 5 minutes requeues, not billed", () => {
  const nowMs = Date.now();
  const base = {
    id: "j1",
    lane: "light",
    workerJobId: null,
    trialStartedAt: new Date(nowMs - 60_000),
    createdAt: new Date(nowMs - 60_000),
    currentStep: null,
    currentStepAt: null,
  };
  assert.equal(classifyStuckJob(base, nowMs), null);
  const stranded = {
    ...base,
    trialStartedAt: new Date(nowMs - STUCK_NO_WORKER_REQUEUE_MS - 1000),
    createdAt: new Date(nowMs - STUCK_NO_WORKER_REQUEUE_MS - 1000),
  };
  assert.equal(classifyStuckJob(stranded, nowMs), "requeue");
});

test("a started job with no real progress for 12h fails, slot freed", () => {
  const nowMs = Date.now();
  const stale = {
    id: "j2",
    lane: "heavy",
    workerJobId: "w-1",
    trialStartedAt: new Date(nowMs - STUCK_NO_PROGRESS_FAIL_MS - 1000),
    createdAt: new Date(nowMs - STUCK_NO_PROGRESS_FAIL_MS - 1000),
    currentStep: "crawling",
    currentStepAt: new Date(nowMs - STUCK_NO_PROGRESS_FAIL_MS - 1000),
  };
  assert.equal(classifyStuckJob(stale, nowMs), "fail");
  const fresh = { ...stale, currentStepAt: new Date(nowMs - 60_000) };
  assert.equal(classifyStuckJob(fresh, nowMs), null);
});

test("null timestamps fall back to createdAt, never null-means-stuck", () => {
  const nowMs = Date.now();
  const justAdmittedNulls = {
    id: "j3",
    lane: "light",
    workerJobId: null,
    trialStartedAt: null,
    createdAt: new Date(nowMs - 60_000),
    currentStep: null,
    currentStepAt: null,
  };
  assert.equal(classifyStuckJob(justAdmittedNulls, nowMs), null);
});

test("the worker create body carries the lane cap hint", () => {
  const body = buildWorkerCreateBody({ jobId: "j1", lane: "light", params: {}, laneMaxConcurrent: 3 });
  assert.equal(body.laneMaxConcurrent, 3);
});

test("a worker 404 means it never saw the job: fail it, keep it failed", () => {
  assert.equal(isWorkerMissing(404), true);
  assert.equal(isWorkerMissing(500), false);
  assert.equal(isWorkerMissing(200), false);
});
