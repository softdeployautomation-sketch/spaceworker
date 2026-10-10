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


---

## 2026-10-10 — S3 IN PROGRESS (deployed + LIVE BATTERY RAN — it found 4 real FAILs)

### Deploy facts (with two traps worth remembering forever)

- rsync app/lib/components/tests/prisma + package.json → md5 parity confirmed. **MISSING: scripts/**
  (had to rsync separately when the CLI couldn't find qa-battery.ts — always sync scripts/ too).
- **TRAP 1 — `BUILD_EXIT:0` LIED.** First build "succeeded" (exit 0) but the type-check worker
  had FAILED (`Type error: File '/opt/spaceworker/tests/hosting-domains.test.ts' not found`) and
  .next/BUILD_ID was ABSENT → service crash-looped on "Could not find a production build".
  Next 16.2.9: the worker's exit code does not propagate to `npx next build`'s status.
  **Truthful build gate from now on: status file AND BUILD_ID exists AND `grep -c "Type error"` = 0.**
- **TRAP 2 — rsync -a propagates LOCAL 600 PERMS + my UID.** `tests/hosting-domains.test.ts` was
  mode 600 locally (stray from an old tooling mishap); rsync -a copied 600 + UID 501 to the box →
  trmm couldn't read it → the type-check failure. Fixed: local chmod 644 (only such file in the
  synced trees — audited), box chown -R trmm:trmm on app/lib/components/tests/prisma. **Post-rsync
  habit: chown -R trmm:trmm the synced dirs.**
- Rebuild (after both fixes): BUILD_ID **`1dQhxq9Kurl7BH78k2V60`**, type-errors 0, service
  **active**, http:200. (Known quirk again: box .env PORT=3400 vs real listener :3500.)

### LIVE BATTERY RUN — the first live run ever (CLI on the box as trmm)

`npx tsx scripts/qa-battery.ts` → **32 probes: 26 pass, 1 warn, 4 fail, 1 skip.**
This is the battery doing exactly its job. Triage so far:

1. **FAIL access — anon POST /api/devices → 405, probe expected 401.** TRIAGED: the route is
   GET-only (register lives in Vantra; spaceworker has NO anon write surface at all) — 405 is the
   CORRECT secure answer, the PROBE's expectation was wrong (its unit test used a fake fetch and
   never validated the real route shape). FIX IN PROGRESS: expect 401 OR 405 (405 = better).
2. **FAIL internal — /api/internal/browser-profiles → 404, probe expected 401.** TRIAGED: the dir
   exists but has NO route.ts (only a `[id]` subdir) — my `discoverInternalRoutes` lists ANY dir,
   a blind spot. Local and box agree (no drift). FIX IN PROGRESS: only list dirs containing route.ts.
3. **FAIL platform — Migration ledger: 1 unfinished/rolled-back row.** NOT YET TRIAGED — next:
   identify the migration name on the box (read-only query), then resolve honestly.
4. **FAIL build — 3 client chunks contain "topsecret6199".** TRIAGED: PRE-EXISTING (not from this
   deploy) — the admin app's own source files (protected layout/page, devices-tab,
   admin-login-form, device pages) legitimately reference the secret path and compile into client
   chunks, so the path is discoverable by anyone pulling /_next/static JS. First surfaced ever by
   this battery. Fix = derive the path at runtime (no literals) — a TASK_188-design change touching
   several files. **DEFERRED to owner decision** (report it; the real gate is the admin session).
5. **WARN freshness — screenshot pipeline STALE** (newest 2026-10-09T20:10Z, ~8h before run).
   Informational — likely screenshots off or a stopped sweep; owner visibility only.

Also proven live: /admin path → 307 (never 200), 13/14 internal guards 401 (the 14th is finding #2),
carrier silent-install tripwire PASS on the REAL box render, presence freshness fresh, config
(telegram/resend/internal-bearer) all configured, Vantra probe SKIP (VANTRA_URL unset in
spaceworker's env — by design here).

NEXT (this slice continues): fix probe #1 + #2 in lib/qa/battery.ts with unit tests → gates →
rsync + rebuild (route bundle embeds battery) → live re-run expecting 2 fails gone → triage the
migration row → admin-route live probe with minted session (`/tmp/t195-health-probe.ts` ready on

---

## 2026-10-10 — S3 COMPLETE: probe fixes committed, rebuilt, LIVE-VERIFIED end-to-end

### Probe refinements (all committed: 105fd40 anon-405 + discoverer, f360ef1 migration ledger)

1. `anon-device-register` accepts **401 OR 405** — route is GET-only (register lives in Vantra);
   405 = no anon write surface at all.
2. `discoverInternalRoutes` lists only dirs **containing route.ts** (a lone [id] subdir is not a
   route — that was the live 404 cry-wolf on browser-profiles).
3. Migration ledger split in two probes after live triage proved the FAIL was a STALE DUPLICATE
   row (`assistant_foundation`: rolled back 12:37:52, successful retry 12:37:55 — schema IS
   applied): `migrations` now counts only rows with **no successful same-name sibling** (real
   never-applied failures → FAIL); the superseded noise gets its own `migration-artifacts`
   WARN probe. Gates: tsc 0 · eslint 0 · qa-battery **30/30** · admin-qa-health 7/7.
   (Caught my own TS bug mid-slice: `timed()` is a discriminated union — must narrow via `.ok`.)

### Final rebuild + service (rebuilt 3× this slice; each recorded with the TRUTHFUL gate)

rebuild3: `BUILD_EXIT:0` + **type-errors 0** + BUILD_ID **`sHlfJGEqXwxsLFqHSfh7c`** → chown →
restart → **active + http:200**. (Trap repeated once: box .env PORT=3400 vs real listener :3500 —
probes/scripts must force PORT=3500.)

### LIVE BATTERY — FINAL STATE (box CLI + admin route, both ran for real)

**CLI** (`/tmp/t195-battery-final.log`): **28 pass / 2 warn / 1 fail / 1 skip.**
**Admin route** (`/api/admin/health` with a REAL minted admin session — self-contained probe,
inline jose mint with exact claims, token never printed): `status 200, cache-control: no-store`,
counts identical to CLI: `{pass:28, warn:2, fail:1, skip:1}` — the admin UI channel is proven
end-to-end live.

All four live FAILs from the first run are RESOLVED (3 were probe false-fails, fixed; 1 real):
- anon register → PASS (405, "no anon write surface")
- browser-profiles guard cry-wolf → GONE (13/13 guards PASS)
- migration ledger → PASS + honest cosmetic WARN
- **REMAINING FAIL (real, pre-existing, deferred to owner): `build-leak` — 3 client chunks
  contain the admin string** (admin app's own components/pages compile the path into client JS).
- WARNs: Ledger stale rows (cosmetic) · Screenshot pipeline STALE ~8h (screenshots likely off —
  visibility only) · Presence freshness flips pass/warn with real user activity (expected).
- SKIP: Vantra probe (VANTRA_URL unset in spaceworker env — by design).
Box probes t195-mig.ts + t195-health-probe.ts deleted (PROBES_CLEANED).

### OWNER DECISIONS STILL OPEN (the only items between here and a 100% green battery)

1. **Chunk leak remediation** (the one FAIL): derive the admin path at runtime in the ~6 source
   files that hardcode it (client chunks then compile clean) — a TASK_188-design change; needs
   owner go/no-go. Real protection (admin session gate) is already proven by the access probes.
2. Screenshot staleness cause (feature off vs. sweep stopped) — visibility only.

### How the owner runs it after any deploy

Admin panel → **Health** tab (fresh run each open, `no-store`), or on the box:
`sudo -u trmm -H bash -c 'cd /opt/spaceworker && set -a && . ./.env && set +a && npx tsx scripts/qa-battery.ts'`
(exit 0 only when no FAIL). TASK_195 code deliverable is COMPLETE; the task closes when the
owner answers decision #1.


---

## 2026-10-10 — S4 STARTED: chunk-leak remediation (the owner's paste of the live battery = GO)

Goal: `build-leak` FAIL → PASS, battery fully green, with ZERO behavior change to the admin
panel. Strategy (principle: the literal secret path may live ONLY in server code):

1. Enumerate every source file that hardcodes the admin path fragment (grep, whole repo).
2. Identify which of those compile into CLIENT chunks (the probe's 3 files) — those get the
   runtime-derivation treatment; server-only files may keep the literal.
3. Fix shape: server components resolve the path server-side (lib/admin-path.ts, no
   server-only import needed — it just computes a string from the real dir name / env) and
   pass it DOWN to client components as props/params; client components stop importing the
   literal. World-readable /_next/static assets then compile clean; the path only ever
   arrives inside auth-gated RSC payloads. Honest limit (recorded): this is a tripwire-grade
   fix — anyone with an admin session can still read the path from their own payload; the
   REAL gate remains the session cookie (proven by the access probes).
4. Gates per playbook: tsc · eslint (no new) · affected suites + full battery unit ·
   admin-qa-health · rebuild3-style truthful build · live battery → expect build-leak PASS,
   RESULT: PASS.
5. Steps recorded before/after each step; commit per meaningful step.

box) → record final report → commit → owner summary (incl. deferred leak question + stale warn).


### 2026-10-10 06:07 — S4 STEP 1 DONE (code): literal out of all 3 client components

**What changed** (zero behavior change, prop-threading only):
- NEW `lib/admin-path.ts` — the ONE server-side home of the literal
  (`ADMIN_PATH`, `ADMIN_LOGIN_PATH`). Server imports ONLY; doc warns a client
  import would re-create the leak.
- Client components now receive the path as a PROP: `AdminShell` (logout push
  + logo Link), `AdminLoginForm` (post-login push), `DevicesTab` (window.open
  deep link) + its client host `SecretDevicesHost`.
- Server parents pass it: `(protected)/layout.tsx`, `login/page.tsx`,
  `device/101/page.tsx`, `device/[deviceId]/page.tsx` (those two also switched
  their `redirect(...)` to `ADMIN_LOGIN_PATH` — same literal, single source).
- Tests: `admin-screen-monitor` S1-menu lock now asserts the PROP template
  `${adminPath}/device/${device.id}` AND `!tab.includes("topsecret6199")`
  (new tripwire); the console-URL secrecy walk drops the stale devices-tab
  allowance (only route tree + lib/admin-notify.ts may name it now).

**Gates (local, all green):**
- tsc: **0 errors** (first run caught a real syntax bug of mine — `**/*.js`
  inside the doc comment closed the block comment early; fixed, re-ran clean).
- eslint on all touched files: **exit 0**. `devices-tab.tsx` = exactly the
  **2 pre-existing** `react-hooks/set-state-in-effect` errors (verified same
  on `git show HEAD:` version — NOT added by this change; not fixed, per rule).
- `grep topsecret6199 components/` → **no files** (the 3 client sources clean).
- Affected suites: admin-screen-monitor **13/13** · admin-devices **13/13** ·
  qa-battery **30/30** · admin-qa-health **7/7** · admin-notify **19/19** ·
  admin-users-presence **15/15** — **97/97, 0 fail**.

**Next:** commit → rsync → rebuild on box → restart → LIVE battery, expecting

### 2026-10-10 06:17 — S4 STEP 2 DONE (deploy + LIVE GREEN): build-leak FAIL → PASS, battery RESULT: OK

**Deploy evidence (box):**
- rsync of the 9 changed files → `RSYNC_OK`; md5 match (`b40d32961c0d628f620fe20d7cf674c4`
  for lib/admin-path.ts both ends); box sources grep `topsecret6199` = **0** in
  all 3 client components.
- `next build` → **BUILD_EXIT:0** · service **active** · **http:200** ·
  **BUILD_ID `YhbuDCGOP_JXN4smy7Lz2`** (was `sHlfJGEqXwxsLFqHSfh7c`).
- Direct tripwire: `grep -rl topsecret6199 .next/static --include=*.js | wc -l` → **0**
  (was **3** leaking chunks).

**LIVE battery (run as trmm with .env, saved `/tmp/t195-s4-battery.txt`, EXIT:0):**
```
TOTAL: 32 probes — 30 pass, 1 warn, 0 fail, 1 skip
RESULT: OK with warnings — read each WARN above.
```
- **`build-leak` → PASS — 0 hits** (the S3 close-gate FAIL is closed).
- Freshness both PASS now (screenshot 33m — the S3 8h-stale warn cleared on its
  own; presence 0m). Platform: ledger 0 unfinished · BUILD_ID current · disk 79.7%.
- Remaining **1 WARN** = the known cosmetic superseded-ledger row (owner-visible
  by design). **1 SKIP** = VANTRA_URL absent from the box `.env` (same as the
  owner's baseline paste — pre-existing, not introduced here; and a stray
  `.env: line 42: seed: command not found` on sourcing — pre-existing quirk,
  recorded for the config backlog).
- Admin **Health** tab channel: unchanged code path, live-proven in S3 (same
  `runQaBattery`); the CLI run above IS the same battery.

**TASK_195 STATUS: code + deploy COMPLETE, battery GREEN (0 fail).** The task's
two owner-decision gates are now: (1) chunk leak — DONE, no decision needed;
(2) screenshot staleness — cleared by itself, visibility kept. Task closes with
this record; open items are only the documented pre-existing WARN/SKIP.

