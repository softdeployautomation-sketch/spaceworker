# Cline Task 14 — Lead Extractor: show what it's doing while it runs, not just the count

**Repo**: `/Users/mikeolab/spaceworker`. **Scope**: Python worker (one new state field + call sites), one API route, the dispatcher, Prisma schema, the Extract page UI.

## Context — what's already fixed vs. what's still missing

A previous fix (see the commit "Live lead count during a run + fix the double remote-cursor") made the **lead count** update live while a job runs — the dispatcher now persists leads to Postgres on every ~10s tick instead of only at completion, and the extract page's existing 4s poll picks that up. That part is done, don't redo it.

What's still missing is a **textual, step-by-step activity line** — "Searching: doctors in texas", "Visiting page 2 of Google results", "Reading a PDF at https://…", "Extracting a page at https://…" — so the user can see *what* it's doing right now, not just how many leads it's found so far. Confirmed by reading the worker: `on_progress` (passed into `run_automation()`, called from `worker/api.py`'s `create_job()`) currently fires **only when a lead is found** (`worker/automation.py` line ~724, `await on_progress(lead)`) — there is no equivalent "here's the current step" signal anywhere. This task adds that second channel alongside the existing lead-progress one, without touching how leads themselves are found or persisted.

## Part 1 — Worker: track and expose a current-step string

**File: `worker/api.py`** — `JobState` (the dataclass holding per-job state, defined near the top of the file) gets a new field: `current_step: str = ""`. `GET /jobs/{job_id}` (the `get_job()` handler) already returns `status`/`leads`/`error`/`resumeState` — add `currentStep: state.current_step` to that same response dict, always present (not conditionally, unlike `resumeState`) so the frontend can always show *something*.

`create_job()`'s `on_progress` callback currently only takes a `lead: dict`. Add a **second** callback parameter, `on_step: Callable[[str], Awaitable[None]]` (or reuse a single richer callback if you prefer — your call, but keep the existing per-lead callback's shape unchanged for whichever callers already depend on it), that does `state.current_step = text`. Wire it into the `run_automation(...)` call the same way `on_progress` already is.

**File: `worker/automation.py`** — call the new step-reporting callback at each meaningful point in the crawl, matching Task 13's own structure:
- In `_search_and_extract()` / the per-query loop in `run_automation()`: report `f"Searching: {query}"` before calling `search_phase()`.
- In `google_search_paginated()`: report `f"Visiting page {page_index + 1} of Google results"` at the start of each page's loop iteration (this function will need the callback threaded through as a new parameter — follow the same pattern already used for `on_progress` being threaded through `_search_and_extract` → `run_automation`, don't invent a different plumbing style).
- In `_extract_result()` (the function that dispatches PDF vs. HTML per result — added in Task 13): report `f"Reading a PDF at {result.url}"` or `f"Extracting a page at {result.url}"` depending on which branch it takes, before calling `extract_lead_pdf()`/`extract_lead_page()`.

Keep these strings short and plain — they're a live status line, not a log viewer. No need to keep history of every past step; `current_step` is overwritten each time, matching how `state.status` itself works.

## Part 2 — Persist and surface it

**File: `prisma/schema.prisma`** — add `SearchJob.currentStep String?` (nullable, additive). Migration: `prisma/migrations/<timestamp>_add_search_job_current_step/migration.sql`, following the exact style of `prisma/migrations/20260907000000_add_search_job_resume_state/migration.sql` — plain `ALTER TABLE "SearchJob" ADD COLUMN "currentStep" TEXT;`.

**File: `app/api/internal/dispatch/route.ts`** — Phase B's poll loop already reads the worker's `GET /jobs/{id}` response into a typed `data` object (see the existing `data.status`/`data.leads`/`data.resumeState` destructuring). Add `currentStep?: string` to that type, and on every tick where the job is still `"running"` (the same branch that now does the incremental `lead.createMany` — read that code before adding to it, don't duplicate the branch), also call `prisma.searchJob.update({ where: { id: job.id }, data: { currentStep: data.currentStep ?? null } })`. Cheap: one extra scalar column write alongside a call that's already happening every tick.

**File: `app/api/jobs/[id]/route.ts`** — `GET`'s existing `prisma.searchJob.findFirst(...)` already returns the whole row (not a narrowed `select`), so `currentStep` is already included in the response with zero changes needed there — verify this is actually true by reading the route before assuming it, in case a `select` was added later that would need `currentStep` added to it too.

## Part 3 — UI

**File: `app/dashboard/extract/page.tsx`** — the `JobDetail` type (wherever it's defined in this file) needs a `currentStep: string | null` field to match the API response. Render it only while `selectedJob.status === "running"`, right near the existing `{selectedJob.template} template · {selectedJob.lane} lane · {selectedJob.leads.length} leads` line (around line 574) — a small, muted text line beneath it, e.g. `Currently: {selectedJob.currentStep}` — falling back to something like "Starting…" if `currentStep` is null/empty (a brand-new job's first tick may not have reported a step yet). Also add it to the job **list** row if there's room (the compact per-job row in the sidebar list, near where `STATUS_COLORS[job.status]` is rendered around line 529) — optional polish, not required if it makes the row too cluttered; use your judgment on whether it fits without hurting the list's scanability.

## Explicitly not this task

- Any change to how leads are found, extracted, or persisted — Task 13's crawler logic is untouched here.
- A full history/log of every step ever taken — this is a single, overwritten "current step" line, not an activity log or audit trail.
- Applying this to `duckduckgo_search_http`/`duckduckgo_search_playwright` — those are fast, single-page paths where a step indicator adds little value; focus the reporting calls on the `google_search_paginated`/PDF path where a run can genuinely take minutes and the user benefits from seeing progress.

## Verification

1. Start a real job with `pagesPerQuery` set to 3+ so it runs long enough to observe. Confirm the extract page's "Currently: …" line changes over time — first showing a query being searched, then a page number, then individual PDF/page URLs — rather than staying static or blank.
2. Confirm the lead count (already working) and the current-step text update independently and correctly together — a job with zero leads found yet should still show a current step other than blank/null.
3. Confirm a `"done"`/`"paused"`/`"failed"` job's last-known `currentStep` value stays visible (not cleared to null) after it stops — useful context for "where did it get to" even after the fact. If the dispatcher's existing "done"/"paused"/"failed" branches don't already write `currentStep` on those transitions, decide whether to carry the last value forward explicitly or leave the column as whatever the last "running" tick wrote — document whichever you pick in a code comment so it's not accidentally "fixed" later by someone assuming it's a bug.
