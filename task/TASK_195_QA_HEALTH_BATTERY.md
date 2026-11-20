# TASK_195 — QA HEALTH BATTERY (automated post-deploy verification, admin-visible)

**Created:** 2026-10-09 20:26 (owner: "look at all possible test that a qa engineer
would test and automate so our spaceworker can be checked and correct status on
all endpoint without costing or causing issues, and should be transparent on the
admin ui, and i can run to check if all is well after deploy on live")

## GOAL
One command + one admin tab that answer **"is everything well?"** after any
deploy: a battery of READ-ONLY probes over platform, access-control, sweeps,
integrations and the build itself. Pass/warn/fail/skip per probe, transparent in
the admin UI, runnable from the terminal on the box. Zero cost, zero side
effects, zero schema change.

## WHY (the pain it prevents)
TASK_194's ledger (R1–R7) is one long chain of "deploy happened → something
silent broke → only found when the owner clicked". The battery converts the
manual PROMPT_VERIFY checklists into something that runs in seconds, every time,
by the owner themselves.

## HARD RULES (owner's constraint: "without costing or causing issues")
1. **READ-ONLY.** No email, no telegram, no writes anywhere. Internal sweep
   routes are POSTed **without** the bearer key, so `requireInternalBearer`
   401s BEFORE any work — we assert the guard exists, we never run a sweep.
2. **No schema change, no migration.** v1 is stateless (no run history); a
   `QaRun` history table is v2 and would need `migrate deploy`.
3. **No env edits.** Missing config = WARN, never FAIL; values are NEVER
   printed — only `configured: yes/no` booleans.
4. **Bounded:** 5 s timeout per HTTP probe, localhost only, ~20 probes total.
5. **Drift detector:** new internal routes are auto-discovered from
   `app/api/internal/**` at run time; anything unexpected surfaces, never hides.

## DESIGN
```
lib/qa/battery.ts        probe registry + runBattery(deps) — deps (fetch, db,
                         fs, env, origin) injected, same fake-injection style
                         as the existing test suites. NO server-only, NO Next
                         imports, NO prisma import (structural QaDb interface).
scripts/qa-battery.ts    CLI — npx tsx scripts/qa-battery.ts [--json]
                         [--group=x] [--origin=url]; exit 0 = no fails.
app/api/admin/health/    GET (admin session required) — runs the battery
  route.ts                 server-side, returns the full report (S2).
components/admin/        "Health" tab in admin-panel.tsx (S2):
  health-tab.tsx           Run-now button, group cards, per-probe chips +
                           detail + ms, timestamp, MANUAL-checks footer.
```

### Probe groups (v1)
- **platform**  — db ping (`SELECT 1`); failed-migrations count
  (`_prisma_migrations` where unfinished/rolled-back); BUILD_ID + build age;
  disk free %; process uptime.
- **access**    — anon HTTP vs own origin: `/login` 200; `POST /api/devices {}`
  → 401 (+ Device count unchanged if a 2xx ever slipped through); support,
  presence, admin APIs → non-200; secret admin surface → **never 200**.
- **internal**  — every `app/api/internal/*` route POSTed WITHOUT bearer →
  must 401. Auto-discovered from the filesystem → new sweeps are covered the
  day they ship.
- **freshness** — derived sweep health from row ages: newest
  `DeviceScreenshot.createdAt` (screenshot pipeline), newest
  `UserPresenceEvent.createdAt` (presence pipeline). Empty table → SKIP
  (feature unused), not a false red.
- **carrier**   — in-process self-test of the VBS pipeline: real
  `renderCarrierVbs()` output must contain `WindowStyle Hidden` + `--silent`
  and must NOT contain `sc.exe` / `unins000` — the TASK_194 R1/R2 tripwire,
  live on every run.
- **build**     — secret-admin-string count in `.next` client chunks = 0
  (the leak gate, automated).
- **vantra**    — `VANTRA_URL` reachable (any HTTP response = pass; network
  error = fail; env absent = SKIP — the R5 class).
- **config**    — TELEGRAM / RESEND / INTERNAL bearer present as yes/no
  booleans (missing → warn).

## SLICES (smallest → test → gates → commit+push each)
- **S1** lib + CLI + unit tests (battery core; no route, no UI).
- **S2** admin route + Health tab in `admin-panel.tsx`.
- **S3** live run on the box after next deploy; real output recorded in the
  steps file; fix whatever the battery catches.
- **deferred v2:** run history (tiny migration), `deploy-vps.sh` auto-run hook,
  full 224-route expected-access manifest (v1 covers the critical set).

## PRE-WORK ANSWERS (assumptions — override if wrong)
- Stateless v1 is acceptable: owner wants "run and see NOW", not history.
- Battery runs on demand only (no cron) — zero cost at rest.
- Health is a first-class admin tab, not buried in Infrastructure.
- CLI self-discovers origin (QA_ORIGIN → PORT → 3500 → 3000) because the box's
  `.env` PORT (3400) disagrees with the true listener (:3500) — TASK_194 S6 fact.

## GATES (every slice)
`npx tsc --noEmit` 0 · eslint on touched files 0 new · `npm run test:qa-battery`
0 fail + neighbor suites green · full `npm run test` before S3's live run.

## VERIFY (owner, after next deploy)
1. On the box:
   `sudo -u trmm -H bash -c 'cd /opt/spaceworker && set -a && . ./.env && set +a && npx tsx scripts/qa-battery.ts'`
   → all green (warns must be explainable).
2. Admin panel → **Health** tab → Run now → same numbers rendered.
3. Break something on purpose (stop a timer) → the freshness probe goes red.

## RISKS / LIMITS (stated up front)
- The battery cannot test what needs a real Windows machine: agent install on a
  VM, wrapper download dialog, invoice→badge e2e — the panel footer lists these
  as MANUAL so nobody mistakes the battery for total coverage.
- Probes that assert anon access are origin-local; they do not replace the
  nginx-level leak gates, they complement them.