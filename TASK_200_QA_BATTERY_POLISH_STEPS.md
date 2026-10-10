# TASK_200 — QA battery polish (the two lines the owner quoted)

**Status:** PLANNED — created 2026-10-10 (before any code)
**Owner quote:**
- `WARN Ledger stale rows — 1 rolled-back row(s) superseded by successful retries (cosmetic)`
- `SKIP Vantra reachable — VANTRA_URL not configured`

## Root causes (diagnosed BEFORE planning)

1. **Ledger WARN** — by construction `staleMigrationArtifacts()` only counts rolled-back rows that DO have a successful same-name retry (unsuperseded rollbacks are counted by `unfinishedMigrations()` → FAIL). So `>0` ALWAYS means "history, schema applied" — a permanent WARN on every healthy run is wrong signal. → downgrade to PASS with an informative detail.
2. **Vantra SKIP** — the probe reads `VANTRA_URL`, but the app never uses that key: `lib/device-tools.ts` / `lib/clone-transport.ts` use `VANTRA_INTERNAL_URL` with default `https://vantra.spaceworker.top`. Box `.env` has `VANTRA_INTERNAL_TOKEN` only (URL legitimately defaulted). → probe must use the same key + same default as the app. **No `.env` edits** (playbook rule).

## Plan (slices → gates → commit each)

- **S1 — probe fixes in `lib/qa/battery.ts`**
  - Ledger `>0` → `status: "pass"`, detail `N superseded row(s) — retried successfully (history)`; keep WARN only for unreadable/error paths; document why.
  - Vantra probe: `VANTRA_INTERNAL_URL || VANTRA_URL || "https://vantra.spaceworker.top"` (trimmed), detail wording follows.
  - Tests: update `tests/qa-battery.test.ts` (superseded → pass; vantra URL precedence + default).
  - Gates: tsc 0 · eslint 0 new · suites green → commit + push.
- **S2 — live verify** in the shared deploy's battery run: `Ledger stale rows → PASS`, `Vantra reachable → PASS/FAIL (real)` — no SKIP.
- **S3 — closeout record.**

## PROGRESS

_(entries appended after every step — dated, with proof)_
