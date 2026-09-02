# SpaceWorker Task 2 — Extraction Worker Adaptation

**Depends on**: Task 1 (needs a running Next.js app + DB to eventually call into, though this task's own work is mostly in the Python worker and can be developed/tested standalone first). **Read `PLAN.md` first.**

## What exists already — read before touching anything

**`worker/automation_server.py` in this repo** — the real, working extraction engine, already copied in and ready to edit (originally from a separate commercial desktop product, `lead-extractor`). `AutomationManager.run_automation(query, params)` is already a plain, Streamlit-free function; the work here is adapting its *interface* and fixing the isolation gaps, not replacing its logic. Also already copied in: `worker/extractors/{email,name,phone}_extractor.py`, `worker/filters/email_domain_rules.py`, `worker/utils/{pdf_logging,email_normalize}.py`.

**This is a deliberately curated subset, not the full original product** — its commercial hardware-bound licensing system (`app/license/`, a hardcoded license-validation secret in its `app/config.py`) and its SQLite persistence layer (`app/database/db.py`, which pulled in that same `config.py`) were intentionally left out and must **not** be re-added or re-fetched from the original product. Import paths were already rewritten from `app.*` to `worker.*` to match this repo's layout. One line was deliberately commented out rather than fixed:

```python
# REMOVED for SpaceWorker Task 2: this worker is stateless per job (no DB writes
# of its own — see TASK_02_EXTRACTION_WORKER.md). The original save_search/save_leads
# calls further down this file need to be deleted, not just this import — search for
# their call sites and remove them as part of building the new POST /jobs API wrapper.
```
**Find every call site of `save_search(...)`/`save_leads(...)` in `worker/automation_server.py` and delete them** (not stub them out with a no-op — remove the calls entirely) as part of this task. The exact line numbers as copied in (subject to shifting once you start editing — re-search if these drift): **270, 821, 1088, 1613, 1699, 1809, 1856, 1870, 1950, 2050.** Some of these assign a return value used later in the same function (e.g. `master_search_id = save_search(...)` at line 821, `saved_count = save_leads(...)` at 1699/1950) — read each surrounding function before deleting, since removing the call without checking whether its return value is referenced further down will leave a dangling variable reference. The new `POST /jobs`/`GET /jobs/{id}` API below is what returns leads to the caller; nothing in this worker should be writing to a database of its own.

## 1. Wrap it as a small job API (new file, e.g. `worker/api.py`, FastAPI or plain `aiohttp`)

- `POST /jobs` body `{ query, params }` → `{ jobId }`. Generate `jobId` server-side (`uuid4`), store per-job state in a plain in-memory `dict[jobId, JobState]` (replacing the current module-level singleton — this is the actual bug being fixed: today only one job can run per process at all, with no per-job isolation).
- `GET /jobs/{jobId}` → `{ status: "running"|"done"|"failed", leads: [...], error?: string }`. Partial leads may be returned while `status: "running"` if the extractor already streams incrementally — check whether `broadcast()` calls carry incremental leads today and preserve that, just route it into the per-job dict instead of a WebSocket.
- `POST /jobs/{jobId}/stop` → best-effort cancellation of that job's asyncio task.
- **Bearer token auth on every route**, checked against an env var (`WORKER_AUTH_TOKEN`) the Next.js app also holds. **Bind the listener to `127.0.0.1` only** — this must never be reachable from outside the box, matching the exact posture already proven for Vantra's `MSI_GENERATOR_SECRET`/TRMM API key (localhost-only, bearer-token, never through nginx).
- Replace the `broadcast()` WebSocket call inside `automation_server.py` with a plain injected callback parameter (`on_progress: Callable`) that the new API layer supplies — this is the one real structural change to the existing file, everything else (the actual scraping/extraction logic) stays as-is.

## 2. Concurrency — two lanes, not one global semaphore

Per `PLAN.md`'s addendum: `light` and `heavy` lanes, each its own `asyncio.Semaphore(1)` (so worst case 2 concurrent headless-Chromium-or-HTTP jobs total, never 1 light job blocked behind a heavy one). The **lane is passed in from the caller** (Task 3's dispatcher decides this, based on the user's choice on the extraction form) — this worker doesn't need to know *why* a job is light or heavy, just which semaphore to acquire before running it.

## 3. The lightweight DuckDuckGo conversion — verify, then convert

Confirmed in the existing code: the DuckDuckGo path already hits `https://html.duckduckgo.com/html/?q=...`, a genuinely static, non-JS page (that's specifically why it avoids CAPTCHA — see the code's own comment), but currently loads it via a full Playwright/Chromium navigation and DOM-scrape.

**Before ripping out the browser dependency for this path**: write a small standalone script that does a plain `requests.get()` (with a normal browser `User-Agent` header) against the same URL for a real test query, and confirm the returned HTML parses identically with the same `.result`/`.result__a`/`.result__url` CSS selectors already used in the existing Playwright-based scraper. If it matches, replace the DuckDuckGo path with `requests` + `BeautifulSoup` — this drops that path's cost from ~300–500MB (a Chromium instance) to single-digit MB, and it's the path most users will use most of the time (no-CAPTCHA default). **Leave the Google path on Playwright unchanged** — it genuinely needs a real browser for CAPTCHA handling, per the existing code's own logic.

If the plain-HTTP test does *not* match (e.g. DuckDuckGo serves different markup to non-browser clients, or rate-limits differently) — don't force the conversion. Report back what actually happened rather than shipping a broken scraper; the Playwright fallback stays fine either way.

## 4. Per-job filesystem isolation ("the wall" from `PLAN.md`)

- Each job gets its own throwaway directory, `/tmp/spaceworker-jobs/{jobId}/`, created at job start.
- **Every browser launch (Playwright, for the Google path or any future browser-dependent tool) uses a fresh, temporary profile inside that job's own directory** — never a shared or long-lived profile at this stage. (Per-user *persistent* profiles are explicitly Phase 1.5, a separate later task — do not build that here.)
- Delete the job's entire temp directory when the job ends, success or failure, unconditionally (a `finally` block, not a happy-path-only cleanup).
- Any exported/output file (if the worker itself ever writes one, rather than just returning JSON) stays inside that job's own temp directory and is never referenced by another job's ID.

## Verification

1. Fire two jobs from two different simulated "users" (just two different `POST /jobs` calls with different params) into the same lane; confirm the second genuinely queues behind the semaphore rather than running concurrently, and confirm each returns only its own leads.
2. Fire one `light` and one `heavy` job at the same time; confirm both run concurrently (different semaphores), not serialized against each other.
3. Confirm the worker rejects any request missing the bearer token, and confirm it's unreachable except from `127.0.0.1`.
4. Confirm the DuckDuckGo lightweight-conversion test (or the decision not to convert, with the reason) is documented in the PR/commit, not silently decided either way.
5. Kill a job mid-run via `POST /jobs/{jobId}/stop`; confirm its temp directory is still cleaned up.
