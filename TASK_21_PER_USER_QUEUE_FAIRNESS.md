# Task 21 — Fair, per-user queue dispatch (don't let one user's backlog block another's)

**Status: ready to implement.** Written 2026-09-11, confirmed against the real current dispatcher code.

## The gap, confirmed directly

`app/api/internal/dispatch/route.ts`'s claim logic, inside the per-lane transaction:

```ts
const entry = await tx.jobQueueEntry.findFirst({
  where: { lane, status: "queued" },
  orderBy: [{ priorityTier: "desc" }, { createdAt: "asc" }],
  include: { searchJob: true },
});
```

This picks the single globally-oldest (or highest-priority) queued entry in the lane, with no awareness of which user it belongs to. Each lane only runs one job at a time (`asyncio.Semaphore(1)` per lane, confirmed in `worker/api.py`). So if User A queues 5 jobs, User B's job — queued after A's first but before A's later ones — waits behind all 5 of A's, even though B has been waiting just as long for their one job. There's no starvation protection today.

## The fix: prefer a different user than whoever was served last, when one is waiting

The moment a lane frees up (a job finishes, pauses, or fails), that's exactly the right point to ask "should the same user go again, or does someone else deserve this turn?" Implement round-robin-by-user, falling back to plain FIFO when no other user has anything queued:

```ts
// Fairness: don't let one user's backlog starve another user's queued job in
// the same lane. Find whichever user this lane most recently ran a job for
// (dispatched at all, regardless of how it ended), and if a DIFFERENT user
// has a queued entry, prefer their oldest/highest-priority one over this same
// user going again. Falls back to plain FIFO when no other user is waiting --
// this never disadvantages a lone user with a full queue.
const lastServed = await tx.searchJob.findFirst({
  where: { lane, workerJobId: { not: null } },
  orderBy: { updatedAt: "desc" },
  select: { userId: true },
});

const candidates = await tx.jobQueueEntry.findMany({
  where: { lane, status: "queued" },
  orderBy: [{ priorityTier: "desc" }, { createdAt: "asc" }],
  include: { searchJob: true },
  take: 200, // bounded scan -- see note below
});
if (candidates.length === 0) return null;

const otherUserEntry = lastServed
  ? candidates.find((c) => c.searchJob.userId !== lastServed.userId)
  : undefined;
const entry = otherUserEntry ?? candidates[0];
```

Replace the existing `findFirst` call with this block; everything after it (the `updateMany` claim, the `searchJob.update` to `"running"`) stays exactly as it is — only which entry gets selected changes.

**Bounded scan note**: `take: 200` caps how many queued rows this reads per dispatch cycle. If a lane's queue is ever genuinely deeper than 200 AND the only other-user entries sit beyond that cutoff, they won't be found this cycle (falls back to FIFO within the scanned batch). This is a reasonable, documented tradeoff for the queue depths this product actually sees today — revisit only if real usage shows lanes routinely queuing hundreds of jobs deep.

## Why this specific design, not something more elaborate

- **No new schema, no new state to track** — "who ran last" is derived from `SearchJob` itself (`workerJobId: { not: null }`, ordered by `updatedAt desc`), not a separately maintained counter that could drift out of sync.
- **Self-correcting**: because "last served" is read fresh every dispatch cycle from real job history, there's no persistent round-robin pointer to get stuck or reset incorrectly after a deploy/restart.
- **Never penalizes a lone user**: if only one user has anything queued in a lane, `otherUserEntry` is always `undefined` and behavior is identical to today.
- **This is exactly "if a user pauses, another user's own can start"** — a pause, a failure, or a normal completion all update the job's status away from "running," which is what makes the lane's `running` count in Phase A's existing check drop to 0 and the lane eligible for a new claim — this task only changes *which* queued entry gets picked once that happens, not whether it happens.

## Explicitly out of scope

- Not changing the underlying one-job-per-lane concurrency model (`asyncio.Semaphore(1)` per lane) — this task is about fairness in *who* gets the single slot next, not about running more jobs simultaneously. If Task 20 (browser-driven search discovery) is ever implemented, its own resource-cost concerns are separate from this task.
- Not adding per-user rate limits or caps on queue depth — a user can still queue as many jobs as they want; this task only affects dispatch order, not how many jobs someone is allowed to have queued.
- Not touching `priorityTier` semantics — a queued entry's priority still matters when comparing among a given selection; this task only adds the user-fairness dimension on top.

## Verification

1. Queue 3 jobs from User A and 1 job from User B (interleaved by creation time, e.g., A, A, B, A) into the same lane.
2. Confirm dispatch order is: A's first job runs (nothing else has run yet, so "last served" is null/irrelevant), then — once that finishes/pauses — **B's job runs next** (a different user than whoever just ran), then A's remaining two jobs in their original order.
3. Confirm a lone user with 5 queued jobs in a lane still gets them dispatched in plain FIFO order (no regression when there's no fairness conflict to resolve).
4. Confirm a job that **pauses** (not just completes/fails) correctly frees the lane for a different user's job on the next dispatch cycle — this is the literal "if a user pauses, another user's own can start" behavior requested, and should already follow from Phase A's existing `running` count check once this task's selection logic is in place.
