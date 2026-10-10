# TASK_200 — QA battery polish (the two lines the owner quoted)

**Status:** PLANNED — created 2026-10-10 (before any code)
**Owner quote:**
- `WARN Ledger stale rows — 1 rolled-back row(s) superseded by successful retries (cosmetic)`
- `SKIP Vantra reachable — VANTRA_URL not configured`

## Root causes (diagnosed BEFORE planning)

1. **Ledger WARN** — by construction `staleMigrationArtifacts()` only counts rolled-back rows that DO have a successful same-name retry (unsuperseded rollbacks are counted by `unfinishedMigrations()` → FAIL). So `>0` ALWAYS means "history, schema applied" — a permanent WARN on every healthy run is wrong signal. → downgrade to PASS with an informative detail.
2. **Vantra SKIP** — the probe reads `VANTRA_URL`, but the app never uses that key: `lib/device-tools.ts` / `lib/clone-transport.ts` use `VANTRA_INTERNAL_URL` with default `https://vantra.spaceworker.top`. Box `.env` has `VANTRA_INTERNAL_TOKEN` only (URL legitimately defaulted). → probe must use the same key + same default as the app. **No `.env` edits** (playbook rule).

## Plan (slices → gates → commit each)

_**Scope extended 2026-10-10 ~07:40 by the owner** — the batch now also covers:
auto-run every 15 min with a scrollable run history on the admin UI; the admin
tab strip must stop scrolling horizontally (all tabs visible across ~3 wrapped
lines); and, after this task, a PLAN-ONLY doc for the standalone
mailer/campaign EXE (TASK_201_MAILER_EXE_PLAN.md)._

- **S1 — probe fixes in `lib/qa/battery.ts`**
  - Ledger `>0` → `status: "pass"`, detail `N superseded row(s) — retried successfully (history)`; keep WARN only for unreadable/error paths; document why.
  - Vantra probe: `VANTRA_INTERNAL_URL || VANTRA_URL || "https://vantra.spaceworker.top"` (trimmed), detail wording follows.
  - Tests: update `tests/qa-battery.test.ts` (superseded → pass; vantra URL precedence + default).
  - Gates: tsc 0 · eslint 0 new · suites green → commit + push.
- **S2 — 15-min auto-run + scrollable history**
  - Schema: additive `QaBatteryRun` model (ranAt, origin, durationMs, pass/warn/fail/skip counts, result, trigger `timer|manual`, failed-probe summary JSON) + migration (apply via `migrate deploy` on the box BEFORE build).
  - `lib/qa/history.ts`: `appendQaRun()` (insert + prune to last ~576 rows ≈ 6 days at 15-min cadence; failures-only detail JSON to bound row size) + `listQaRuns()`.
  - `GET /api/admin/health/runs` (admin-gated, no-store) returns newest-first runs.
  - `/api/admin/health` POST-run append: manual panel clicks append too (trigger `manual`).
  - New `/api/internal/qa-battery-sweep` route (bearer-gated, single-flight, counts-only JSON — mirrors governor-sweep shape) that runs the battery and appends (trigger `timer`).
  - Box ops: `qa-battery-sweep.service` + `.timer` (`OnBootSec=3min`, `OnUnitActiveSec=15min`) copying the governor unit pattern verbatim (Bearer from EnvironmentFile — the 2026-09-24 401 lesson).
  - Tests: history append/prune/list (fake db), route guards (401 anon), static tripwires for the timer unit files' key fields.
- **S3 — admin UI**
  - HealthPanel: run-history scroll list (newest first, auto-refresh ~60s while tab open, click a row to load that run's stored report? — stored detail is summary-only, so row shows counts + failed probe labels), "Run now" button kept.
  - Tab strip: remove `overflow-x-auto` scrolling; `flex-wrap` so the 19 tabs render across ~3 lines — Health reachable without scrolling.
  - Static UI tests updated/added.
- **S4 — deploy + live verify + closeout** (`migrate deploy` first, build, restart, battery live: ledger PASS, Vantra PASS/FAIL real, timer fired ≥1 row in history, panel shows it) → AFTER-RECORD → push.
- **S5 — write `TASK_201_MAILER_EXE_PLAN.md`** (plan only — standalone mailer/campaign EXE; open questions for the owner).

## PROGRESS

_(entries appended after every step — dated, with proof)_

### 2026-10-10 07:56 — TASK_200 S1 DONE: both quoted lines fixed in the probe core

Diagnosed BEFORE coding (recorded in the plan above): the ledger WARN was a
permanent false-alarm by construction, and the Vantra SKIP read a key the app
has never used (`VANTRA_URL` vs the real `VANTRA_INTERNAL_URL` + default
`https://vantra.spaceworker.top`; box `.env` carries the TOKEN only).

Changes (`lib/qa/battery.ts`):
- Ledger artifacts `>0` → PASS with `(history)` detail; unreadable/error paths keep WARN; comment explains why a permanent yellow is anti-signal.
- Vantra probe: resolves `VANTRA_INTERNAL_URL → VANTRA_URL → default`, always probes (no SKIP arm), detail prints the URL actually reached.

Tests (`tests/qa-battery.test.ts`):
- baseDeps env now sets `VANTRA_INTERNAL_URL` (matches production).
- Artifacts test: superseded → PASS.
- Vantra describe rewritten: recording-fetch asserts (a) empty env probes the DEFAULT url and passes, (b) INTERNAL wins over legacy + trailing slash trimmed, (c) legacy alone still honored, (d) network error → FAIL.
- Own lint miss caught by gates (unused `r`) and fixed before commit.

Gates: `tsc` **0 errors** · eslint **0 problems** (clean) · `test:qa-battery`
**33/33 pass** (was 30 — three new vantra tests).

### 2026-10-10 — PAUSED for TASK_202 (owner interrupts; nothing lost)

S1 committed+pushed at `b31eeae`. S2 (15-min auto-run battery history in the
Health panel, tab-strip wrap to ~3 lines, then the mailer-EXE plan doc
TASK_201) is **NOT started** — resume here after TASK_202 closes. Full S2
context lives in the plan section at the top of this file.
