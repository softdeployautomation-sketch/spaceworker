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

