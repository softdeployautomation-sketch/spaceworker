# TASK_168 — EXTRACTION QUEUE P0 + SUMMARY LIMIT DIAL (owner bugs)

## 0. Read first (binding)

- HOW_WE_MOVE_FAST.md + SENIOR_HANDOFF.md §4 + §5 traps.
- PROMPT_NEXT_VERIFICATION_AGENT.md §1 — binding.
- Rules: `git add` explicit paths only (TASK_133 file is the owner's,
  never touch it); commit with `-F<file>`; never print secrets; never edit
  `.env`; never build on the VPS; never `git stash`; use `CI=true npm run build`.
- State: `main` @ `08cd67c`, pushed + deployed. TASK_167 live — don't touch it.

## 1. BUG A (P0) — queue set to 3, only 1 user gets results

Owner: "we already have a queue system and i set it to allow 3 users at a
go, but when 3 users are running, only one is getting results."

Verified facts (reproduce, don't assume):

- Dials: `dispatchLightMaxConcurrent` / `dispatchHeavyMaxConcurrent`
  (`prisma/schema.prisma:279-281`), both `@default(1)`. Confirm the LIVE row
  actually holds 3 before assuming code is at fault.
- Phase A admits per lane, `running >= maxConcurrent` pushes back
  (`app/api/internal/dispatch/route.ts:158-180`). Push-back is by fixed
  index (`candidates.slice(0, ...)`), so check head-of-line blocking.
- HARD MISMATCH: worker holds ONE slot per lane, hardcoded
  (`worker/api.py:163-164`, `asyncio.Semaphore(1)`). Phase A can admit 3
  while the worker serialises to 1.
- Worker reject path (POST non-OK) requeues with resume data KEPT
  (`route.ts:226-252`) — confirm the requeued row is clean.
- Phase B polls only `running` (`route.ts:280`); slot frees in
  `finalizeJobAndMeter` (`route.ts:292-309`). A serialised job holds its
  lane slot until the 12h TTL (`route.ts:128-148).
- Stall signal exists, nothing consumes it: `currentStepAt` advances only
  on real step change (`route.ts:401-411`).

## 2. BUG A fix contract

1. Worker concurrency follows the admin dial — no hardcoded 1. Size the
   lane semaphores from the cap (env or admin API, never a second
   hardcoded constant). Default stays 1 until the dial says otherwise.
2. Phase A fairness: a full lane must not starve other lanes' candidates
   in the same tick. Test: lane X full + lane Y healthy → Y dispatches.
3. Worker-rejected jobs requeue as CLEAN `queued` rows (no stale resume
   data). Test the requeue shape.
4. An admitted-but-never-started job must not hold its slot indefinitely
   — bound it; prove a stuck-`running` job releases its lane.
5. Keep: worker 404 → `finalizeJobAndMeter(failed)` (`route.ts:311-317`).

Tests: lane-fairness, reject-requeue shape, slot-release, 404-finalise.
Gates: tsc + wallet 39 + topup 22 + support 50 + hosting 334 + ESLint
touched-only (worktree baseline) + `CI=true` build, before EACH commit.
Two commits (A then B), explicit `git add`, `-F` commit, push (push ≠ deploy,
leave deploy to the verifier).

## 3. BUG B — "daily summary limit (24 frames)" is hardcoded

Owner: "i need the daily limit not hardcoded. and nothing like 24 frames
should be the daily limit." Screen timeline shows
"No summary — this machine's daily summary limit (24 frames) is reached."

Verified facts:

- Cap `SCREENSHOT_SUMMARY_MAX_FRAMES_PER_DEVICE_PER_DAY = 24`
  (`lib/screenshot-summaries.ts:75-87`); calls cap
  `SCREENSHOT_SUMMARY_MAX_CALLS_PER_DEVICE_PER_DAY = 8` (`:89-102`).
  Breach marks `summaryError = "daily_call_budget"` (`:464-480`).
  UI hardcodes "(24 frames)" (`components/screen-timeline.tsx:55-56`).
- Summary pass reads raw AdminSetting (`:200-221`); AI/day-boundary dials
  NOT admin-editable (`:104-128`). Capture dials resolve separately
  (`lib/device-screenshots.ts`).

Fix contract:

1. Migration (additive, nullable-safe):
   `screenshotSummaryMaxFramesPerDevicePerDay` (default 24 — byte-identical
   until touched) + `screenshotSummaryMaxCallsPerDevicePerDay` (default 8).
   Clamp frames 1..1000, calls 1..100, calls ≤ frames; NULL/invalid → 24/8.
2. `resolveSummarySettings` reads them; budget in `summarisePendingFrames`
   uses resolved values. UI copy interpolates the dial — never "24" when
   the dial says otherwise.
3. Surface both dials in admin UI beside the existing screenshot dials.
4. Tests: default 24/8 · raised binds less · lowered binds more ·
   NULL/invalid fallback · UI copy matches dial. Scratch-DB replay only.

## 4. Report back

1. Bug A: live dial values; root cause (`file:line`); where worker
   concurrency comes from now; fairness proof.
2. Bug B: migration name; values tested; copy before/after.
3. Gate table, real output. Honest unverified list.

