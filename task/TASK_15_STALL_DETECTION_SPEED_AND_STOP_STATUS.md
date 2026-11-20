# Cline Task 15 — Lead Extractor: stall detection, leads-list scrolling, extraction speed, and a real "stopped" status

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: Python worker, one API route, Prisma schema, the Extract page UI, the stop route.

## Part 1 — Fix "Stop" showing as a failure

**Confirmed bug**, `app/api/jobs/[id]/stop/route.ts`: when a user clicks Stop, this route sets `status: "failed", error: "Cancelled by user"`. A deliberate, user-initiated stop is not a failure — the UI currently has no way to tell the two apart, so a job the user stopped on purpose shows exactly like a real crash.

- Add `"stopped"` as a real status value alongside the existing `"queued" | "running" | "done" | "failed" | "paused"` (see the comment on `SearchJob.status` in `prisma/schema.prisma`, and the `JobStatus` type near the top of `app/dashboard/extract/page.tsx` — update both).
- Change the stop route's update to `status: "stopped"` and drop the `error` field for this path (it's not an error).
- Update every place that branches on `job.status` in `app/dashboard/extract/page.tsx` (search for `"failed"` in that file) to treat `"stopped"` as its own case — a neutral/gray badge, not the red "failed" one. Same for the admin queue tab in `app/admin/(protected)/admin-panel.tsx` if it renders job status badges.
- Confirm the dispatcher (`app/api/internal/dispatch/route.ts`) doesn't itself treat `"stopped"` as a state it needs to react to (it shouldn't pick up a stopped job again) — read the polling loop's `where` clauses before assuming this, since a status change like this can silently affect a query filter elsewhere.

## Part 2 — Leads list keeps growing the page instead of scrolling

**Confirmed in a live screenshot**: on the Extract detail view, the leads list (`selectedJob.leads.map(...)` around line 719 of `app/dashboard/extract/page.tsx`) renders every lead with no limit, inside a container (`line 599`, `flex-1 overflow-y-auto`) that isn't actually height-constrained by its parent — so instead of scrolling internally, the whole page grows and the dock/nav at the bottom gets pushed around or overlapped.

- Give that container (or its parent) a real bounded height (e.g. a `max-h-[...]` matching the viewport minus the header/toolbar it sits under, or a flex/grid layout with `min-h-0` on the ancestor chain — Tailwind's `overflow-y-auto` does nothing without a constrained height on the scrolling element or one of its ancestors having `min-h-0` in a flex context; check the actual DOM/flex chain rather than guessing which ancestor is missing it).
- Once truly scrollable, there's no need for a separate pagination/limit mechanism — "let users scroll" (the user's own words) is the desired behavior, not a page-number control. Don't build pagination; just fix the scroll container.
- Verify by loading a job with 100+ leads and confirming the leads list scrolls in place while the rest of the page (header, activity line, dock) stays fixed.

## Part 3 — Stall detection on the existing activity feed

**Task 14 (live "Currently: …" step text) is already fully implemented and working** — confirmed by reading `worker/api.py`'s `on_step`/`current_step`, `worker/automation.py`'s call sites (`Searching: …`, `Visiting page N of Google results`, `Reading a PDF at …`, `Extracting a page at …`), the dispatcher's per-tick `currentStep` write, and the Extract page's `Currently: {selectedJob.currentStep}` line. **Do not rebuild this — it works.** What's missing is a way for the user to tell "it's genuinely stuck" from "it's just on a slow step" without someone manually checking worker logs (which is how this was diagnosed live during development — that's not a sustainable way for the actual user to answer this question day to day).

- **Prisma**: add `SearchJob.currentStepAt DateTime?` (nullable, additive — same migration-file style as the existing `currentStep` migration).
- **Dispatcher** (`app/api/internal/dispatch/route.ts`): the same tick that already writes `currentStep` should also write `currentStepAt: new Date()` **only when the incoming `currentStep` value is different from what's already stored** (read the current row's value first, or accept writing the timestamp on every tick if that's simpler and cheap enough — your call, but note which you picked and why, since "every tick" vs. "only on change" gives different meanings to "how long has it been on this step").
- **Extract page UI**: while `status === "running"`, if `Date.now() - new Date(currentStepAt).getTime()` exceeds a threshold (**5 minutes** — long enough that a slow PDF download or a CAPTCHA backoff isn't mistaken for a stall, per the existing `CAPTCHA_BACKOFF_SECONDS = 20` and human-pacing delays already in `worker/automation.py`), show a small warning next to the "Currently: …" line — e.g. "This may be stalled — no progress in over 5 minutes." Don't auto-stop or auto-retry anything; this is a visibility signal only, the user still decides whether to hit Stop themselves.

## Part 4 — Extraction throughput: investigate first, don't just "speed it up" blind

The user's own report: a previous, different system (not this one, not on this VPS) auto-extracted every email from one PDF, saved them, and moved to the next — reportedly reaching ~500k leads in a couple of minutes. The current system is much slower than that, and the user wants to know why and have it fixed.

**Before changing anything**, profile a real run and report back with actual numbers — don't assume which part is slow:
- Time a single query end-to-end (search → results → per-result extraction) and break down how much of that time is: the deliberate human-pacing delay before navigation (`random.uniform(1.5, 3.5)` at `worker/automation.py` ~line 340, and any similar delays elsewhere — these exist specifically to avoid Google's CAPTCHA wall, confirmed the actual, dominant fix for a real problem earlier in this project — don't remove them without a real replacement anti-detection strategy, or the crawler goes back to being CAPTCHA-blocked most of the time), vs. actual page/PDF download time, vs. `extract_lead_pdf()`/`extract_lead_page()`'s own parsing time, vs. anything else (browser cold-start, DB writes, etc).
- Report those numbers before proposing a fix. It's very likely the two systems aren't doing comparable work at all — a system that "auto-extracts every email from one PDF and moves to the next" sounds like it was working from **an existing local/known corpus of PDFs** (no live Google search, no per-query navigation, no CAPTCHA risk at all), which is a fundamentally cheaper operation than this system's live search-and-crawl approach. If that's confirmed true, say so plainly rather than chasing a speedup that isn't actually achievable while still doing live web search — and separately propose what, if anything, in *this* system's own pipeline (not the pacing delays that exist for a real reason) is actually a legitimate bottleneck worth fixing.
- Concrete things that ARE worth checking regardless: is `extract_lead_pdf()`/`extract_lead_page()` for multiple queued results running strictly one-at-a-time when it could safely run a few in parallel (bounded concurrency, not unlimited — still needs to respect the same anti-detection pacing per actual page navigation, but PDF *parsing* of an already-downloaded file has no CAPTCHA risk and could run concurrently with the next navigation)? Is anything re-launching a browser context per query instead of reusing one across the whole job? These are the kind of real, bounded wins to look for — not blanket "remove all delays."

## Part 5 — Private browser: confirm, don't blindly "fix," the multi-process observation

Separate subsystem (`browser-server/server.ts`, the private-browser feature — unrelated to the lead extractor above). The user observed 2 `chromium` processes in the VPS's top-processes list for a single active browser session (previously 3, before a recent fix that stopped a popped-out tab from running a second live connection to the same session).

A single real Chromium instance normally shows up as **multiple** OS processes on its own (a main process plus separate GPU-process and renderer-process children) — this is expected Chromium behavior, not evidence of a duplicate session, and was directly observed this way when a real test session was inspected via `docker exec <container> ps` earlier in this project (renderer/gpu-process/zygote all listed separately for one browser). **Confirm this explicitly** before doing anything else here: start exactly one session, `docker exec` into its container, and count how many `chromium`-labeled processes belong to that ONE container vs. how many separate `spaceworker-browser-*` containers actually exist system-wide. If it's one container with 2 internal chromium-family processes, this is not a bug — document that finding in this task's notes and close it. Only investigate further if there are genuinely **two or more separate containers** running for what the user believes is one session.

## Explicitly not this task

- Rebuilding Task 14's activity feed — it already works, this task only adds staleness detection on top of it.
- Removing or shortening the human-pacing/CAPTCHA-avoidance delays without a real, tested replacement — that's how the crawler ends up CAPTCHA-blocked again, a problem already solved once this project and not worth reintroducing for a speed number.
- Building a paginated leads list — the fix is a real scroll container, not page numbers.

## Verification

1. Stop a running job manually — confirm it shows a distinct "Stopped" state, not "Failed," in both the job list and detail view, and that the admin queue tab (if it shows job status) agrees.
2. Load a job with 100+ leads — confirm the leads list scrolls inside its own box while the header/activity line/dock stay fixed, and the browser's own page-level scrollbar doesn't move.
3. Start a real job with `pagesPerQuery` set to 3+, and deliberately don't touch it for 5+ minutes while it's genuinely between steps (or artificially delay a step during testing) — confirm the "may be stalled" warning appears, and confirm it disappears again once `currentStep` changes.
4. Provide the real profiling numbers from Part 4 before implementing any speed change, and get sign-off on the diagnosis before spending time on a fix that may not be achievable given the live-search architecture.
5. Confirm Part 5's finding (one container, multiple internal chromium processes = expected) and document it — or, if genuinely more than one container is found for one session, report that back with the exact repro steps rather than guessing at a fix.
