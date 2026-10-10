# TASK_195_STEPS — live log (enter BEFORE and AFTER every meaningful action)

## PRE-RECORD — 2026-10-09 20:26
- Owner task: QA battery ("look at all possible test that a qa engineer would
  test and automate… correct status on all endpoint without costing or causing
  issues… transparent on the admin ui… i can run to check if all is well after
  deploy on live"). Prioritized ahead of everything else, incl. TASK_194 S5.
- Research complete (facts, all greped this session):
  - **224** API routes; **15** internal sweep routes, every one guarded by
    `requireInternalBearer(req)` (lib/internal-auth.ts, env
    `INTERNAL_BEARER_TOKEN`) → 401 **before** any work ⇒ unauthed POST is a
    safe existence-check.
  - `getAdminSession()` at `lib/admin-auth.ts:80` — admin-route guard pattern.
  - `AdminSetting` is a **fixed-column singleton** (lib/admin-settings.ts),
    NOT key-value ⇒ no history slot without a migration ⇒ v1 stateless.
  - **No** sweep last-run markers exist anywhere (`lastRunAt` only in
    automation-run) ⇒ freshness must be DERIVED from row ages.
  - `DeviceScreenshot.createdAt` (schema:2677 block) and
    `UserPresenceEvent.createdAt` (schema:3800 block, task190) confirmed.
  - `lib/support/tickets.ts` has **0** `sendEmail` hits ⇒ TASK_194 S5
    (user email on admin reply) genuinely still open — queued after this.
  - Carrier builder = `renderCarrierVbs(cmd, options)` (vantra-carrier.ts:419),
    pure, CLI-safe import (no server-only) ⇒ usable as an in-process tripwire.
  - `lib/prisma.ts` is `server-only` + lazy ⇒ CLI must construct its own
    `PrismaClient`; the battery core takes a STRUCTURAL db interface instead.
  - Login page = `app/login/page.tsx` ⇒ anon GET `/login` must be 200.
  - Box listens on **:3500** while its `.env` claims 3400 (TASK_194 S6 fact)
    ⇒ CLI origin resolution tries QA_ORIGIN → PORT → 3500 → 3000.
- Plan committed in `TASK_195_QA_HEALTH_BATTERY.md`. Proceeding to S1
  (lib + CLI + unit tests). Record AFTER each slice below.

---

---

## 2026-10-09 — S1 PAUSED MID-SLICE (owner priority interrupt: XDevice remote-control bug)

Owner: "try to pause the test task... quickly jump to this bug in the xdevice
tier, they are getting blocked from remote control. it shows disconnect even
when the device is online, but it works on premium plus".

**State left behind (UNCOMMITTED WIP, do not commit until green):**
- `lib/qa/battery.ts` created (~430 lines) — battery core, all 8 probe groups.
- `scripts/qa-battery.ts` created (~250 lines) — CLI, real deps, origin
  resolver (QA_ORIGIN → PORT → 3500 → 3000), human+JSON output, exit codes.
- NOT yet done: `tests/qa-battery.test.ts`, package.json script entries,
  tsc/eslint gates, test run, commit.
Resume = write tests → gates → commit S1 exactly as planned.

---

## 2026-10-10 — S1 DONE (resumed from pause; all gates green)

Resumed exactly where the pause left off: wrote `tests/qa-battery.test.ts`
(329 lines, 27 tests in 8 describe blocks, all hermetic — fake db/fetch/fs/env,
no network/no DB). Added package.json `test:qa-battery`.

**Defects the gates caught in the WIP core (all fixed before commit):**
1. Carrier block called `const r = timed(...)` WITHOUT `await` — probe would
   always report garbage (`r.ok` on a Promise). Fixed + `timed()` widened to
   accept sync closures (`() => Promise<T> | T`).
2. Shared http() now uses `redirect:"manual"` — with the default
   `redirect:"follow"`, the secret-surface probe would see the 307→/login as
   a 200 and FALSE-FAIL against a perfectly healthy app. Pinned by test.
3. Test-harness bugs (not code bugs): fake fetch lacked the internal-route
   paths and a network-throw wildcard; config probe ids use dashes not
   underscores; freshness tests passed `now` in opts instead of deps.

**GATES (final run, all three):**
- `npx tsc --noEmit` → **0 errors**
- `npx eslint lib/qa/battery.ts scripts/qa-battery.ts tests/qa-battery.test.ts`
  → **clean (exit 0, 0 problems)**
- `npm run test:qa-battery` → **27/27 pass, 0 fail** (8 suites, ~554 ms)

**Coverage pinned (what a QA battery must guard, per the task plan):**
platform (db/migrations/build-age/disk/uptime) · access (anon login 200,
anon register 401 + side-effect row-count tripwire, anon admin API ≠200,
secret surface never-200 via manual-redirect) · internal drift detector
(every app/api/internal route auto-probed 401 with no bearer, discovered
from fs so new sweeps are covered the day they ship) · freshness (screenshot
6h / presence 30m STALE warns, no-rows = skip not red) · carrier tripwire
(in-process render check: Hidden + --silent, no sc.exe/unins000 — the
TASK_194 regression class) · build leak gate (admin-string in .next chunks)
· vantra reach (R5 class) · config booleans (values NEVER in report output).

**Files:** lib/qa/battery.ts (466) + scripts/qa-battery.ts (246) +
tests/qa-battery.test.ts (329). CLI is READ-ONLY by construction; exit 0
unless a probe FAILs. NEXT SLICE: S2 (admin UI panel + route) per plan,
then S3 (deploy + live run + closeout).




---

## 2026-10-10 — S2 DONE (admin UI transparency; all gates green)

Built the "one-click health check after deploy" surface:

1. **Shared adapters moved into `lib/qa/battery.ts`** so the CLI and the admin
   route run the IDENTICAL battery (they can never disagree about "healthy"):
   `createQaDb(structuralClient)` (still NO prisma import — header rule 4 kept),
   `createFsDeps(root)`, `discoverInternalRoutes(root)`, `resolveOwnOrigin()`.
   `scripts/qa-battery.ts` now imports them; its local copies deleted; behaviour
   identical (qa-battery suite stayed 27/27 through the refactor).
2. **`app/api/admin/health/route.ts`** — GET: admin session FIRST (anon → 401,
   battery never runs for them), then runBattery with the SHARED prisma
   singleton (no second client pool), no-store JSON. Cast note: Prisma's
   generic `$queryRaw` overloads don't structurally unify with QaPrismaLike
   (TS assignability limit, documented in both call sites).
3. **`components/admin/health-panel.tsx`** — click-to-run ONLY (no auto-run;
   opening the tab costs nothing), PASS/WARN/FAIL/SKIP badges per probe,
   grouped table, ALL-GREEN/OK-with-warnings/FAIL banner, ran-at/origin/ms
   line, manual-checks footer (VM install, wrapper dialog, invoice→badge).
   Response types declared locally — never imports lib/qa (node:fs+prisma
   must not enter the client bundle).
4. **admin-panel.tsx** — `health` tab appended LAST in TABS + Tab type +
   render line + import.

**GATES (final):** tsc **0 errors** · eslint on all five new/changed files
**exit 0, 0 problems** · admin-panel.tsx **exactly its 42-error pre-existing
baseline** (no new) · `test:admin-qa-health` **7/7** · `test:qa-battery`
**27/27** (regression through the adapter move). package.json gained
`test:admin-qa-health`.

Tests pin: guard-before-battery order, 401, no-store, no `new PrismaClient`
in the route, no admin-string in route/panel, shared-adapter exports exist,
CLI has no duplicated adapter definitions, panel is click-only (no
useEffect), renders all four statuses, never imports lib/qa, and the tab is
registered/rendered/imported.

NEXT SLICE: S3 — deploy to VPS (no migrate needed — no schema change),
live-run the battery on the box (CLI + admin UI click), record the report,
closeout TASK_195.
