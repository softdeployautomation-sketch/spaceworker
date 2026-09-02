# SpaceWorker Task 3 — Priority Queue, Lanes, and the Extraction UI

**Depends on**: Task 1 (auth/scaffold) and Task 2 (the worker's `/jobs` API must exist and accept a lane parameter). **Read `PLAN.md` first**, especially the "priority queue" and "two queue lanes" addendum sections — this task implements exactly what's described there.

## Prisma additions

```prisma
model SearchJob {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  query     String
  params    Json     // whatever shape Task 2's worker expects — pass through opaquely
  status    String   @default("queued") // "queued" | "running" | "done" | "failed"
  lane      String   // "light" | "heavy" — user's choice at creation time
  workerJobId String? // the worker's own jobId, set once dispatched
  createdAt DateTime @default(now())

  @@index([userId, createdAt])
}

model JobQueueEntry {
  id           String   @id @default(cuid())
  searchJobId  String   @unique
  searchJob    SearchJob @relation(fields: [searchJobId], references: [id])
  priorityTier Int      // SNAPSHOTTED from user.tier at enqueue time — never re-read live later
  lane         String   // "light" | "heavy"
  status       String   @default("queued") // "queued" | "dispatched"
  createdAt    DateTime @default(now())

  @@index([lane, status, priorityTier, createdAt])
}
```

Add `searchJobs SearchJob[]` to `User`.

**Why `priorityTier` is a copy, not a live join to `User.tier`**: if the admin changes someone's tier while their job is sitting in the queue, that job keeps the priority it was queued with. Only jobs queued *after* the tier change get the new value. This is a deliberate design choice from `PLAN.md` — don't "simplify" it into a live join, that would silently reorder a customer's already-waiting job in a way that's confusing to explain.

## The dispatcher

A small, separate long-running process (or a systemd-timer-triggered script running every few seconds — match whichever is simpler to operate, a timer is fine since jobs aren't sub-second-latency-sensitive) that, for each lane (`light`, `heavy`) independently:

1. Check whether that lane currently has a free worker slot (query Task 2's worker for currently-running job count in that lane, or track it locally in `JobQueueEntry.status`).
2. If free, pop the `queued` entry with the highest `priorityTier` (ties broken by oldest `createdAt`) for that lane.
3. Mark it `dispatched`, call the worker's `POST /jobs` with that job's `query`/`params`, store the returned `workerJobId` on the `SearchJob` row, flip `SearchJob.status` to `running`.
4. Separately (or in the same loop), poll `GET /jobs/{workerJobId}` for any `running` `SearchJob`; on completion, write the returned leads into the `Lead` table (see below), flip status to `done`/`failed`, and free that lane's slot.

## `Lead` model + extraction results

```prisma
model Lead {
  id           String    @id @default(cuid())
  userId       String
  user         User      @relation(fields: [userId], references: [id])
  searchJobId  String
  searchJob    SearchJob @relation(fields: [searchJobId], references: [id])
  email        String?
  phone        String?
  contactName  String?
  businessName String?
  website      String?
  sourceUrl    String?
  snippet      String?
  createdAt    DateTime  @default(now())

  @@index([userId, searchJobId])
}
```
Field names match what the extractor already emits (per `PLAN.md`) — don't rename them, keep the mapping trivial.

## Admin: tier editing

Simplest possible UI — an admin users list (same shared-passcode admin panel from Task 1) showing each user's email, current `tier`, and an inline editable number input + save button. **No automatic tier-from-payment logic** — this is a plain manual field the operator sets, exactly like Vantra's `isStaff`. Don't build anything fancier than this (no tier names/enums, no self-service upgrade flow tied to it) until there's a real reason to.

## Customer-facing extraction form

`app/dashboard/extract/page.tsx` (or wherever Task 1's dashboard shell expects it): a form with a query input, whatever params Task 2's worker needs (result count target, search engine choice if exposed), and **a "Quick" vs. "Deep" toggle that directly sets `lane`** — no hidden heuristic guessing at job cost, the user makes this tradeoff explicitly. On submit: create the `SearchJob` + `JobQueueEntry` (snapshotting `user.tier` into `priorityTier`) in one transaction, show it in a "My jobs" list with live status (poll `GET /api/jobs` every few seconds), and once `done`, show the results in a table with a CSV export button.

## Verification

1. Two different users (one with `tier: 0`, one with `tier: 5`, set manually via the admin panel) both submit a `light`-lane job around the same time; confirm the higher-tier user's job dispatches first.
2. Bump a user's tier *after* they've already queued a job; confirm that already-queued job's priority does **not** change (still uses the snapshotted value).
3. Submit one `light` and one `heavy` job simultaneously; confirm both run concurrently, not serialized.
4. Confirm a job's results only ever appear in the queuing user's own "My jobs" list — basic tenant-isolation check, same discipline as everywhere else in this project.
5. CSV export produces a real, correctly-formatted file with the right rows for that specific job.
