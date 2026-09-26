# Task 105 — Resource Governor: automatic queue for every high-RAM feature

**Status: READY FOR BUILD — assigned to Cline, 2026-09-26 (owner priority pick).**
TASK_97 (Browser Clone) is already merged and live, so this is no longer "build
alongside" anything — `cloneSessions`/the hosted pool already exist as a real,
running feature to register and wire against from day one. TASK_120 (native-host
delivery, the OTHER open clone item) is separately deferred to Michael's own track —
do not conflate the two; this task does not depend on it.
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §CROSS-TRACK RULE 7 (admin limits),
`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7 (pooled host + admin cap).**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 — migrations, deploy, live verification (and §6b's
  post-migration drift check if this task adds a queue table — always run it).
- **`app/api/admin/admission-control/route.ts`** + its `AdminSetting` fields — the
  existing pattern this task generalises (enabled + maxConcurrent + LIVE counts).
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §CROSS-TRACK RULE 7.

## Agent contract
Commit only — no deploy, no ssh, no `.env`. Branch `agent/task-105-resource-governor`.
Hand-write any migration SQL (never `migrate dev`), mirroring the style of existing
migrations in `prisma/migrations/`. Never write PowerShell/JSX through a shell
heredoc. Explicit file paths, never `git add -A`. `npx tsc --noEmit` clean before
reporting done. End the run by reporting: files changed, `tsc`/test output, and
anything you could not verify locally (this task's own acceptance list requires live
verification — e.g. "queued request survives `systemctl restart`" — that only the
owner can run against the real VPS; say so plainly rather than claiming it).

## Goal
One **server-side governor** that watches real resource pressure and **queues** any
high-RAM feature when the box is at its limit — automatically, without an admin
having to babysit it. Premium users get priority; **premium can still be queued** when
demand is high enough, because the limit is the machine, not the plan.

## Why
Today each high-RAM feature has its own cap (dispatch light/heavy, browser sessions,
Vantra links, device actions; Browser Clone adds clone sessions + a pooled host).
Caps stop *unbounded* growth but nothing reacts to actual load: three features can
each be "under their cap" and still put the VPS into swap. The owner wants automatic
queueing so premium can proceed normally, and everyone (including premium) waits in
line when the box is genuinely full.

## Deliverables
1. **`lib/resource-governor.ts`** — one place that answers:
   `requestSlot(feature, { userId, priority })` → `granted | queued(position, eta)`.
   - Reads the feature's AdminSetting cap (from RULE 7) **and** live pressure
     (RAM used %, swap, per-feature running count, CPU load).
   - Priority: `premium` (tier 5 / premium entitlement) > `standard` > `trial`.
   - **Premium bypasses the *soft* queue when the box is healthy** and is queued
     like everyone else when pressure crosses the hard threshold.
   - Fair FIFO within a priority class; no starvation (a `standard` request that has
     waited > N minutes is promoted — otherwise premium traffic can starve free users
     indefinitely).
2. **Pressure model** — thresholds as `AdminSetting` keys (no hardwired numbers):
   `governorEnabled`, `governorRamWarnPct`, `governorRamHardPct`,
   `governorSwapHardMb`, `governorQueueTimeoutSec`, `governorStarvationPromoteMin`.
   Defaults chosen so nothing changes until an admin turns it on.
3. **Feature registry** — the governor knows every high-RAM consumer. Seed from the
   existing mechanisms (`dispatchLight`, `dispatchHeavy`, `browserSessions`,
   `vantraLinks`, `deviceActions`) plus **`cloneSessions`** and **`hostedPool`**
   (TASK_97). Adding a feature = one registry entry, not a new subsystem.
4. **Queue state + surface** — queued requests are persisted (status `queued`,
   position, requestedAt, grantedAt) so a queue survives a service restart; the user
   sees an honest state in the UI (`Waiting for a free slot — 2 ahead of you`), and
   the admin panel shows per-feature: cap, live count, **queued count** (extends the
   admission-control card, no new page).
5. **Wiring** — every new consumer must call `requestSlot`; a consumer that skips it
   is a bug. Clone pipeline (TASK_97) is the first integration and its acceptance
   includes queueing correctly under a saturated pool.
6. **Sweep** — a timer (pattern: `deploy/digest-sweep.{service,timer}`) that releases
   expired queue entries, promotes starved requests, and logs pressure transitions
   (`normal → warn → hard → normal`) to the audit trail.

## Acceptance
- With the governor DISABLED (default), behaviour is byte-identical to today.
- Saturate the box artificially → a standard request queues, a premium request is
  granted while healthy, and **both queue** when the hard threshold is crossed.
- Queued request survives `systemctl restart spaceworker`; grant order is FIFO within
  a priority class; the starvation promotion fires.
- Admin panel shows queued counts per feature and can tune every threshold at runtime.
- `tsc --noEmit` clean; §2 deploy + live verification.
