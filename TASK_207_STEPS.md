# TASK_207_STEPS.md — BEFORE / AFTER log (compaction-safe)

Running log. Read this + TASK_207_MOBILE_CONSOLE_LEAK_AND_DESKTOP_VIEW.md to resume.

---

## BEFORE record — 2026-10-14 (planning; NO code yet)

### Ground truth (real greps, line-verified)
- `components/device-console.tsx:3793` — `<iframe src={mesh.control} sandbox="allow-scripts allow-same-origin allow-forms">`. MeshCentral console iframe.
- `components/device-console.tsx:3801-3810` — TASK_170 mobile height: `fullScreen ? "min-h-0 flex-1" : "h-[70dvh] sm:h-[480px]"`. Mobile only resizes height; does NOT change WHAT MeshCentral renders.
- `lib/device-tools.ts:114-118` — `MESH_ORIGIN_REWRITE` maps `mesh.instaweb.top → mesh.spaceworker.top`. **Cross-origin** (different subdomain from `spaceworker.top`) ⇒ cannot inject into contentDocument.
- `lib/device-tools.ts:144` — `fetchMeshUrls` → `vantraFetch("/api/internal/sw/devices/<vantraAgentId>/mesh-urls")` returns control/terminal/file. Vantra mints the single-use `login=` token.
- `app/console/[deviceId]/page.tsx:38` — `<DeviceConsole deviceId fullScreen initialTab />` (chrome-free route).
- `app/layout.tsx:30-34` — viewport `{ width:"device-width", initialScale:1, viewportFit:"cover" }`. Normal responsive Tailwind site; NO "force desktop" mode exists anywhere.
- n.eko contrast (TASK_208): `lib/browser-session-serialize.ts:16-20` `connectUrlFor` → `${APP_BASE_URL}/browser/<id>/?embed=1` ⇒ **same-origin**, injectable.

### Findings
- The "Individual Devices, 6 nodes" leak = MeshCentral's own group node-list. The `mesh.control` token logs into a MeshCentral mesh GROUP containing many nodes (not scoped to the user's single device). On desktop the tree is a hidden side-nav; on a phone MeshCentral reflows and the node list becomes primary → exposes other users' nodes. (Hypothesis — needs S0 live confirm; device offline.)
- Console iframe is cross-origin, so we CANNOT inject CSS/JS the way n.eko does. Fix must be a same-origin proxy (B1) or a source/Vantra fix (A1) or a URL-param display fix (A2).

### Owner decisions required (BLOCKING, see doc §6)
1. A1 (Vantra per-user mesh — real fix, cross-repo) AND A2 (display mitigation, here)? Or A2 only?
2. Commit to B1 (same-origin MeshCentral proxy + touch overlay) or stay A2 + "open in new tab"?
3. Build the touch module ONCE and share with TASK_208 n.eko?

### State
- Branch to cut when implementing: `agent/task-207-mobile-console` off `origin/main`. (Currently on `agent/task-205-link-routing-wording`; working tree has uncommitted clone-resync `device-console.tsx` + `deploy-vps.sh` — see TASK_135_CLONE_RESYNC_STEPS.md. Do NOT let those ride along.)
- BLOCKED on: owner decisions above + a device online for S0 live confirm.

---

## BEFORE record (append) — 2026-10-15 (discovery completed; owner direction locked; still NO code)

### Research answers (primary sources — resolves the S0-blocked hypothesis)
- **TRMM token = group session, PROVEN:** Vantra sw route proxies TRMM `/agents/<id>/meshcentral/` (`vantra/lib/trmm.ts:404-405`); the confirmed-live comment (`vantra/lib/meshcentral-api.ts:299-330`) quotes the URLs as `.../?login=...&gotonode=<x>&viewmode=11&hide=31`. TRMM already sends `hide=31` yet the phone still showed "Individual Devices, 6 nodes" ⇒ **MeshCentral's mobile reflow defeats the `hide` param** ⇒ display-param fixes (A2) rejected WITH evidence, not opinion.
- **Guest share link = single device, server-enforced:** MeshCentral `createDeviceShareLink` yields a guest/share view that shows ONLY the shared node — no group, no tree. Upstream meshctrl.js (Ylianst/MeshCentral PR #5888, fetched 2026-10-15): `terminal→p|=1; desktop→p|=2; files→p|=4; if (p==0) p=2;` and unlimited = `expire: 0`; message shape `{action:'createDeviceShareLink', nodeid, guestname, p, consent, expire:0, viewOnly}`. ⇒ **`p: 7`** mints desktop+terminal+files on ONE URL scoped to ONE node. (Current Vantra `createShareLinkOnSocket` sends `p: 2` = desktop-only.)
- **Cross-origin wall confirmed:** `mesh.spaceworker.top` ≠ `spaceworker.top` (`lib/device-tools.ts:114-118` rewrite) ⇒ no CSS/JS/touch injection into the MeshCentral iframe ⇒ no same-origin proxy (B1 rejected), no in-tab overlay for MeshCentral.
- **Leak fix lives in Vantra (A1/V1):** reuse existing `createShareLinkOnSocket` + `findMeshNodeIdByHostname`/`matchMeshNode` (fail-closed, Task 106) inside the `mesh-urls` route under `?scope=device`. Admin path (no param) unchanged = TASK_147 silent support viewer by design.

### Owner direction (locked)
1. Fix the leak FOR REAL (Vantra per-device share mint). Display-only hiding rejected.
2. Mobile: the console opens in a NEW TAB (no proxy).
3. Honest caveat recorded: TASK_208's `lib/touch-controls.ts` cannot inject into cross-origin MeshCentral — touch/keyboard in the new tab = MeshCentral's own guest/mobile UI; the shared module stays the engine for same-origin embeds (n.eko).

### Final plan (full detail: task doc §4)
- **V1 (vantra, branch `agent/task-207-mesh-scoped-mint`):** `createConsoleShareLink` (`p:7, viewOnly:false, expire:0, consent:0`) + route `?scope=device` → hostname→nodeid (fail-closed) → share URL returned as `control`/`terminal`/`file` + `scoped:true`; ANY failure → loud log + fail-open TRMM fallback (console never breaks). Tests: share-message builder + route scope/fallback.
- **S1 (spaceworker):** customer `fetchMeshUrls` appends `?scope=device`; `adminFetchMeshUrls` does NOT (source-contract test locks both). Branch `agent/task-207-mobile-console` off `origin/main`; clone-resync WIP (`components/device-console.tsx`, `scripts/deploy-vps.sh`) committed FIRST as its own labeled commit.
- **S2 (spaceworker):** below `sm` only — mesh iframe(s) → "Open in new tab" card(s) (`window.open(url,'_blank','noopener,noreferrer')`); desktop (>sm) untouched (diff guard).
- **S3 live mint verify (device offline is FINE):** mint for the test node from Vantra env → curl share URL → HTTP 200 + single-device guest view; records the default app for Terminal/Files tabs.
- **S4 phone verify:** BLOCKED (test device offline).

### State / gates
- Task doc rewritten today: §2 CONFIRMED addendum, §3 decision, §4 finalized plan, §5 risks, §6 RESOLVED, §7 gates. A duplicate-addendum glitch (first editor call timed out but landed, then retried) was found and deduplicated 2026-10-15.
- Gates: `tsc`/`eslint`/tests in BOTH repos; desktop byte-diff guard; S3 curl-verified BEFORE any phone claim; deploy via hardened script (TSTP/TTIN/TTOU trap).
- BLOCKED on: owner final implementation go-ahead (plan presented with the §5 touch caveat) + device online for S4.

---


## Progress record — 2026-10-15 (V1 implemented in vantra; gates + tests NOT yet run)

Owner go-ahead received (plan + touch caveat accepted). V1 code is written on
`vantra` branch **`agent/task-207-mesh-scoped-mint`** (cut off `origin/main`;
TASK_25 doc WIP was parked via `git stash push -- TASK_25_REQUEST_UNLOCK_NOTIFICATION.md`
before the cut and `git stash pop` restored after — it stays uncommitted, never staged).
Verified `lib/meshcentral-api.ts` identical to origin/main before the cut; `lib/trmm.ts`
differs there only by unrelated TASK_206 lines (16+) — V1 does not touch `lib/trmm.ts`.

### Written so far (vantra)
- **`lib/meshcentral-api.ts`:**
  - `SHARE_APP_TERMINAL=1`, `SHARE_APP_DESKTOP=2`, `SHARE_APP_FILES=4`, `SHARE_APPS_CONSOLE=7`
    (bit values from upstream meshctrl.js / PR #5888).
  - `buildDeviceShareMessage(nodeid, {viewOnly, guestName?, appBits?})` — PURE, exported,
    owns the wire invariants (`consent:0`, `expire:0`, `p` defaults to desktop-only so the
    pre-207 view-only mint's wire format is byte-identical).
  - `createShareLinkOnSocket` now takes a 5th param `appBits = SHARE_APP_DESKTOP` and sends
    via the builder (no behavior change for existing callers).
  - NEW `createConsoleShareLink(nodeid)` — exported; `p:7`, `viewOnly:false`,
    `guestName:"sw-console"`, silent, unlimited.
- **`app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts`:** `?scope=device` →
  `getAgentDetail().catch(→null)` → `findMeshNodeIdByHostname(urls.hostname, detail?.public_ip)`
  (SAME fail-closed mapping as the proven `.../mesh/view-only` route, Task 106) →
  `createConsoleShareLink` → share URL replaces `control`/`terminal`/`file` + `scoped:true`.
  ANY failure inside the scope block → **fail-open** to the broad TRMM URLs with
  `scoped:false` + LOUD `console.error` (console never hard-breaks; fallback never silent).
  No param (admin path) = unchanged `{ok, urls}` response (TASK_147 by design).
  Offline-agent semantics preserved (outer catch still 503).

### Next (immediately in progress)
1. **`tests/mesh-share-console.test.ts`** (designed, not yet written): require-hook stubs —
   `server-only`, `@/lib/db`, **`@/lib/auth`** (DISCOVERY: `lib/spaceworker-service.ts` imports
   `hashPassword` from `@/lib/auth` — the sw-device-move test only stubbed `./db`; ours must
   stub both or the module graph pulls real bcrypt/prisma), and `ws` → scripted fake
   control channel (answers `nodes` + `createDeviceShareLink`); `globalThis.fetch` stub for
   TRMM (`/agents/a1/meshcentral/` + `/agents/a1/` with `client_id:5` to skip `listClients`).
   Cases: builder invariants (p defaults 2, console 7, consent/expire 0) + matchMeshNode
   fail-closed + route (no param → broad, no mint fired; scope=device → share URLs,
   scoped:true, minted message p:7/viewOnly:false/guestname sw-console; ambiguous node →
   fail-open scoped:false, no mint) + 401 without Bearer.
2. Gates: `npx tsc --noEmit`; eslint on the 3 touched files; `npx tsx --test` on the new test
   + existing suite green (sw-device-move, wol-scripts, relay-probe, install-link-zip,
   legacy-host-drift). THEN commit vantra.
3. S1/S2 in spaceworker (branch + clone-resync commit first, scope=device, new-tab cards,
   source-contract tests), then S3 curl mint verify on the VPS.

### State
- vantra working tree: 2 modified files (the two above) + parked TASK_25 doc; nothing staged.
- spaceworker: untouched this session (still on `agent/task-208-neko-mobile`, clone WIP present).

---


## Progress record — 2026-10-15 (V1 test file WRITTEN; gates NOT yet run)

### Written: `vantra/tests/mesh-share-console.test.ts` (305 lines)
Real-module unit + route-behavior tests, using the repo's proven require-hook
technique (`tests/wol-scripts.test.ts` / `tests/sw-device-move.test.ts` pattern):
- **REAL `lib/meshcentral-api.ts`** required via RELATIVE path (`../lib/...`) so it
  bypasses the alias stub — tests `buildDeviceShareMessage` (pre-207 wire format:
  p defaults 2, consent 0, expire 0, port null, responseid vantra) + console
  variant (p 7 = 1|2|4, guestname sw-console, viewOnly false, still silent) +
  `matchMeshNode` fail-closed matrix (no match / single+no-ip / IP disagree /
  twin hostnames ambiguous / twin resolved by IP / twin IP-miss → null).
- **REAL route handler** `app/api/internal/sw/devices/[agentId]/mesh-urls` required
  through the hook; stubs ONLY at the import boundary: `server-only`, alias
  `@/lib/meshcentral-api`, `@/lib/trmm` (scripted per-test), `@/lib/sw-agent-tenant`
  (tenantResult switch). `@/lib/sw-internal-auth` stays REAL — the 401 is proven
  against a real `SW_INTERNAL_TOKEN` check, not a stub.
- **11 route/behavior cases:** 401 no bearer (never reaches tenant) · 404 foreign
  agent · no-scope = exact broad response (TASK_147 byte-identical, no mint, no
  node lookup) · scope=device happy path (hostname+public_ip threaded to findMesh,
  exactly one mint for `node//scopednode`, control/terminal/file all = share URL,
  hostname preserved, `GROUP_LOGIN` substring absent) · ambiguous node → 200
  fail-open `scoped:false` + captured `console.error` containing `[TASK_207]` +
  no mint · mint socket failure → 200 fail-open, loud log, mint attempted once ·
  offline → 503 on BOTH paths.
- `console.error` is captured by real swap/restore (`captureConsoleError`), so the
  LOUD-fallback assertion is observed behavior, not an assumption.
- Env: same 9 `required()` vars as the 206 test + `SW_INTERNAL_TOKEN` (confirmed
  `lib/env.ts:92` = `process.env.SW_INTERNAL_TOKEN || null`, optional).
- **Probe done before writing:** `next/server` loads under `npx tsx -e` and
  `NextResponse.json` returns status (401 verified) — so behavioral route tests
  are viable in this repo (first such test; existing vantra tests only assert libs).

### GOTCHA (again — recorded per owner's rule)
Terminal/shell integration MANGLES multi-command strings and sometimes drops
output entirely (branch lists, greps). All inspection this session was done via
single-command calls or by writing scripts/files first — do the same after any
compaction; never chain compound commands inline.

### Branch hygiene note (discovered, NOT a loss)
`main` = `edc71ec` (another agent's installer commit, == origin/main). The
TASK_206 `5bb8078` + relay `6b92c29` commits live only on
`agent/task-206-sw-device-move` (tip 6b92c29) — that is why `tests/sw-device-move.test.ts`
and `tests/relay-probe.test.ts` are absent from THIS branch (cut from origin/main).
Both are preserved on their branch and already deployed to the VPS via rsync.
Current branch `agent/task-207-mesh-scoped-mint` working tree = the 2 implementation
files + parked `TASK_25_REQUEST_UNLOCK_NOTIFICATION.md` (never stage the parked doc).

### NEXT (in order)
1. `npx tsx --test tests/mesh-share-console.test.ts` → fix until green.
2. `npx tsc --noEmit` (0 errors) · `npx eslint` on the 3 touched files (0) ·
   run the full existing suite (`wol-scripts`, `install-link-zip`,
   `legacy-host-drift`) → green.
3. Commit vantra branch (impl 2 files + test; EXCLUDE TASK_25 doc).
4. S1/S2 spaceworker (branch, clone-resync commit first, scope=device caller,
   new-tab UX wiring, tests) → S3 curl mint verify on the VPS.

---


## AFTER — 2026-10-15: V1 VANTRA COMPLETE + COMMITTED (`0f31097`)

### Gates (all green, final run via scripts/t207-gate.sh)
- `npx eslint` on the 3 touched files → **0 problems (0 errors, 0 warnings)**
- `npx tsc --noEmit` → **0 errors**
- `npx tsx --test tests/*.test.ts` (full suite) → **60/60 pass, 0 fail**
  (new file alone = 10/10)

### Commit
- `0f31097` on `agent/task-207-mesh-scoped-mint` (based on origin/main edc71ec),
  exactly 3 files: `lib/meshcentral-api.ts` (+96/−), route (+48/−), NEW
  `tests/mesh-share-console.test.ts` (307) → **+435/−16**.
- Parked `TASK_25_REQUEST_UNLOCK_NOTIFICATION.md` (other agent's WIP) left
  uncommitted — NEVER staged.

### Bugs found & fixed while making the test green (recorded per rule)
1. `assert.equal` on two distinct objects (identical CONTENT) fails by
   reference — use `assert.deepEqual`. The printed expected/actual looked
   identical; the trap is invisible unless you know the operator.
2. `meshApi.MeshCentralNode` as a TYPE namespace fails tsc — `meshApi` is a
   runtime require value, not a namespace. Fixed with an erased type alias:
   `type MeshNode = import("../lib/meshcentral-api").MeshCentralNode;`
3. `get()`/`makeRequest()` header params inferred the narrow `as const` literal
   type from `= BEARER` default → passing `{}` (the 401 test) failed tsc.
   Widened both signatures to `Record<string, string>`.
4. eslint `no-unused-vars` on `_agentId` stub params — repo has NO
   `argsIgnorePattern`, so underscore does not exempt. Dropping the param
   entirely is valid (loader hook imposes no signature).

### Terminal lessons (again)
- Running 3 npm gates in PARALLEL interleaves output in one shared terminal —
  never parallelize foreground npm/ts commands; one at a time or via script.
- Foreground jam clears with a trivial `echo` probe before retrying.

### NEXT: S1/S2 SPACEWORKER (in order)
1. Commit the clone-resync WIP FIRST (`components/device-console.tsx` +
   `scripts/deploy-vps.sh` — both live on the box, must not be lost).
2. Branch `agent/task-207-console-scope` off local `main`.
3. S1: `scope=device` customer path on both callers (customer console +
   admin console) via the now-live mint route.
4. S2: new-tab UX + tree CSS hard-hide; reuse `lib/touch-controls.ts`.
5. Gates → commit → S3: VPS deploy of the Vantra route + verify mint with curl
   (device offline → live URL check deferred until it returns).

---


## Progress — 2026-10-15 S1 START: branch cut, clone WIP secured, callers mapped

### Branch decisions (WHY, recorded so compaction doesn't re-derive)
- Local `main` = `c22b8b3` (cyberlab agent commits there directly — main IS the
  shared integration branch) but it DIVERGED: main lacks my 205/206/208 branches
  (they were cut from `origin/main` `a1704b4`) and vice versa.
- `agent/task-207-console-scope` cut **from `agent/task-208-neko-mobile`**
  (NOT main) — because S2 reuses `lib/touch-controls.ts`, which exists only on
  the 208 branch. Branch tip now: `e1314a8` → `362c6a7` (208) → `a1704b4` (origin/main).
- **`e1314a8`** = the clone-resync WIP captured as its own commit BEFORE 207 work
  (`components/device-console.tsx` full clone UI + movedAt port, and
  `scripts/deploy-vps.sh` TSTP freeze-trap — both already live on the box as
  BUILD_ID `7hzgmeVMp_wXtOe47TcBr`; commit message documents the split rationale).
  Working tree now clean except untracked TASK_*.md docs + scripts (never staged).
- Divergence to remember at MERGE time: local main has cyberlab commits this
  branch lacks; this branch has 205/206/208 + clone WIP main lacks. Whoever
  merges must reconcile device-console.tsx (clone content is the deployed truth).

### S1 caller map (greps + full reads — the change points)
Six touchpoints reference `mesh-urls`:
1. **`app/api/devices/[deviceId]/mesh-urls/route.ts`** (CUSTOMER proxy, Task 95):
   session → `deviceToolsDenied` → `fetchMeshUrls({userId, deviceId, pendingActionId})`
   → `{ok, urls}`; error map device_not_linked→404 / no_active_grant→403 /
   vantra_not_configured→503 / vantra_503→503 / else 502.
2. **`app/api/admin/devices/[deviceId]/mesh-urls/route.ts`** (ADMIN proxy, TASK_147):
   admin session only (no ownership/pendingAction gate by design — comment says so)
   → `adminFetchMeshUrls({deviceId})` → `{ok, deviceId, deviceName, ownerEmail, urls}`.
3. `lib/device-tools.ts` — holds `fetchMeshUrls` + `adminFetchMeshUrls`.
4. `lib/vantra-link.ts` — the actual Vantra HTTP caller.
5. UI consumers: `components/device-console.tsx` (customer) +
   `components/admin/devices-tab.tsx` (admin).
- Next: read `fetchMeshUrls`/`adminFetchMeshUrls` in device-tools.ts + the
  vantra-link call → thread `scope=device` → decide how `scoped:false` fallback
  surfaces (S2 tree-hide is the backstop; STEPS rule: never hide-then-forget —
  the [TASK_207] loud log in vantra is the trace).

---


## Progress — 2026-10-15 S1+S2 COMPLETE: scope threading + new-tab UX, gate GREEN (zero-tolerance)

### New standing rule from the owner (supersedes earlier convention)
- Previous convention "pre-existing errors: split out by owner" is **REVOKED**.
  Owner directive: **no pre-existing errors tolerated — treat them, don't annotate.**
  Any future gate report must be fixed green, never split out.

### S1 done — `scope=device` customer path (`lib/device-tools.ts`)
- `fetchMeshUrls` appends `?scope=device` (GET path-string param through `vantraFetch`;
  Vantra route already reads searchParams — no body plumbing needed).
  Reads `scoped` from the response: `scoped === false` → LOUD `console.error`
  (never silent) and NOT added to the return shape (vantra's own loud log is the trace).
- `adminFetchMeshUrls` deliberately UNCHANGED — admin breadth is TASK_147 by design;
  reason documented in code comment + task doc.
- Editor-insert defect caught by read-back (line 186 opened `"` closed with backtick →
  would be syntax error / non-interpolating `${}`). FIXED. Lesson: read back every
  editor insert on long template strings.

### S2 done — mobile new-tab UX (`components/device-console.tsx`)
- react import += `useSyncExternalStore`; lucide += `ExternalLink`.
- `useIsMobileViewport()` (module level, placement mirrors useTaskBarClock):
  useSyncExternalStore + matchMedia "(max-width: 639px)" (Tailwind sm cascade),
  server snapshot `false` → hydration-safe, mobile-only re-render.
- `ControlTab`: `isMobileViewport` + `embedInPage` opt-out.
  Mobile & !embedInPage → launcher card: bg-emerald-600 CTA
  `window.open(mesh.control, "_blank", "noopener,noreferrer")` + "or view here instead"
  secondary → embed. Desktop embed byte-unchanged (`h-[70dvh] sm:h-[480px]`),
  toolbar (disconnect/PIN/maintenance) above card always.
- In-code honesty note: cross-origin wall — the 208 touch module CANNOT inject into
  the MeshCentral tab; MeshCentral's native full-screen toolbar covers touch modes;
  node-tree leak dies server-side via V1 scoped mint (planned CSS tree-hide dropped
  as redundant — a scoped share has no tree to hide).
- New `tests/console-mesh-scope.test.ts` — 5 source-contract tests (customer scope=yes,
  admin scope=no, loud fallback, new-tab+noopener+opt-out, hydration-safe hook).

### Pre-existing errors TREATED under the new rule (3 of 3, none split out)
1. tsc `device-console.tsx(2034) 'movedAt' not in OnboardingViewInput` — branch base
   (origin/main a1704b4) lacks TASK_206 (unmerged but deployed on the box).
   Fix: `movedAt?: string | Date | null` added to `OnboardingViewInput`
   (lib/device-onboarding.ts:136-141), type MATCHED to the 206 branch field
   (206 lib line 190) so the eventual merge has zero drift. No behavior change here.
2. eslint warning `getAdminSettings unused` (device-tools.ts:7) — proven dead on
   origin/main too (grep count=1 = import line only; diff grep =
   NO_GETADMINSETTINGS_IN_MY_DIFF). Fix: dead import removed.
3. Full-suite FAIL `support-tickets.test.ts:1409 TASK_166 cursor FORWARDS` (±1ms) —
   PROVEN racy TEST, not code: `markTicketRead` (lib/support/tickets.ts:640-643)
   stores `now` when the stored cursor is stale, so exact equality with `first`
   only holds inside one ms; full-suite load ticks the clock. Isolated run = 57/57.
   Fix: assertion now tests the real invariant (`after >= first` — "never backwards"),
   comment cites the route lines that define the contract.

### GATE (scripts/t207-s2-gate.sh → /tmp/t207-gate-*) — ALL GREEN
- `tsc --noEmit` exit **0**
- eslint (device-console, device-tools, device-onboarding, console-mesh-scope) exit **0**
- **FULL suite `tests/*.test.ts`: 1419 tests · 1418 pass · 0 fail · 1 skipped**
  (known DB-gated mailbox test)
- Gate upgraded per the new rule: full suite replaces the 3-file subset;
  device-onboarding.ts added to the lint list.

### NEXT (in order)
1. Commit S1+S2: lib/device-tools.ts, lib/device-onboarding.ts,
   components/device-console.tsx, tests/console-mesh-scope.test.ts,
   tests/support-tickets.test.ts. (Gate scripts + TASK_*.md stay untracked per
   repo precedent.)
2. **S3 deploy order is hard: VANTRA FIRST, THEN SPACEWORKER.** The scoped mint
   (`agent/task-207-mesh-scoped-mint`, commit `0f31097`) deploy status is
   UNVERIFIED — check it. If the old Vantra route is still live it IGNORES the
   `scope` param and silently returns the broad token, which makes our
   `scoped:false` backstop dead code. Sequence: deploy Vantra route → deploy
   spaceworker → curl-verify scope=yes (customer) / broad+loud (admin).
3. Live phone/tree verify deferred — device offline.

## S3 PREFLIGHT (2026-10-15) — EVERY collision trap resolved with evidence; READY TO DEPLOY

### Box state at preflight
- Vantra: active, BUILD_ID `qUqm61vfFmitFjiOPWw9Q` (probe deploy), :3300 = 200
- SpaceWorker: active, BUILD_ID `frIasgkyQ7uJdtkZSDPQ5` (task-208), :3500 = 200
- **Box mint route grep "scope" = 0 → scoped mint NOT deployed.**
  Vantra-first order is MANDATORY: the old route silently IGNORES `?scope=device`
  and returns the broad token without `scoped:false`, which would make the
  spaceworker backstop dead code. (Vantra first is inherently safe: new Vantra +
  old spaceworker = scope param never sent = old behavior.)

### Collision decisions (each proven by hash/diff, scripts t207-preflight.sh +
### t207-vantra-boxonly.sh)
1. `components/device-console.tsx` — box hash `fb69788...` == local commit
   `e1314a8` content EXACT (check E) → box predates only my S2 diff → **DEPLOY SAFE**.
2. `lib/device-tools.ts` — box-only lines are the dead `getAdminSettings` import
   and the OLD pre-S1 fetchMeshUrls shape; 3 hunks only (L7, 165-166→164-180,
   167a182-187) → box stale, not customized → **DEPLOY SAFE**.
3. `lib/device-onboarding.ts` — box hash == **206 branch byte-exact**
   (`ae123b4...`, check G) → **EXCLUDE FROM DEPLOY**: shipping my branch's
   origin/main-based copy would regress the deployed 10-min quarantine state
   machine back to 20-min. The box already has the strictly better version
   (my local copy exists only so local tsc is green).
4. Vantra `lib/meshcentral-api.ts` — 12 box-only lines = the OLD inline
   `createDeviceShareLink` JSON payload (`p: 2` + desktop comment), exactly the
   form my TASK_207 refactor replaced with the parameterized console-variant
   helper (behavior locked by `tests/mesh-share-console.test.ts`, part of the
   60/60 green run) → **DEPLOY SAFE** (replacement, not regression).
5. Vantra mint route — 4 box-only lines = old route form (old import,
   `_request` name, no-scope response) = replaced by V1 `0f31097` → **DEPLOY SAFE**.
6. Vantra local branch state: `agent/task-207-mesh-scoped-mint` clean EXCEPT
   ` M TASK_25_REQUEST_UNLOCK_NOTIFICATION.md` = pre-existing parked doc from
   another task → **NEVER include in any deploy list** (repo precedent).

### DEPLOY LISTS (locked)
- **VANTRA (step 1, first):**
  `lib/meshcentral-api.ts`
  `app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts`
  → rsync → build as `vantra` user (full log to /root file, TSTP-immune,
  BUILD_ID rollback guard — recreate `deploy-vantra-relay.sh`, which was deleted
  in a task-205 script sweep, as `scripts/t207-vantra-deploy.sh`)
  → verify: BUILD_ID changed · :3300 200 · box route greps `scope` > 0.
- **SPACEWORKER (step 2, second)** via hardened `scripts/deploy-vps.sh`:
  `components/device-console.tsx`
  `lib/device-tools.ts`
  `tests/console-mesh-scope.test.ts`
  `tests/support-tickets.test.ts`
  → **device-onboarding.ts deliberately EXCLUDED (decision 3 above).**

### POST-DEPLOY VERIFY (in order)
1. Both BUILD_IDs changed; :3300 and :3500 and public 200; maintenance OFF.
2. Box mint route greps `scope` > 0; box spaceworker device-console greps
   `useIsMobileViewport` + `noopener,noreferrer`.
3. curl customer mesh-urls (login myrate619 / TestUser123) → expect scoped
   response; admin path → broad WITHOUT `scoped` flag (Task_147 by design).
   If the offline device breaks the live mint call, fall back to box-code grep
   + `journalctl -u vantra` (loud `scoped:false` log only fires when scope is
   present but tenant resolution fails).
4. Owner does the admin grant/test themselves (explicit instruction).

### QUEUE AFTER THIS
- CyberLab deploy for the other agent's work — owner will hand me the handoff
  when that agent finishes; deploy from `sw-lab` per the established cyberlab
  procedure (previous runs: TASK_CYBERLAB_UI1_DEPLOY_STEPS.md +
  TASK_CYBERLAB_EGRESS_DEPLOY_STEPS.md).

## S3 DEPLOY — DONE & VERIFIED (2026-10-15). BOTH SIDES LIVE.

### Deploy results (executed in the locked order)
1. **Vantra first** (scripts/t207-vantra-deploy.sh, recreated hardened — the
   old deploy-vantra-relay.sh was swept in the task-205 script cleanup):
   BUILD_ID `qUqm61vfFmitFjiOPWw9Q` → **`JiHmYVEgGEJyrBLNEe7-2`**, service
   active, :3300 = 200, `.next.bak-t207` cleaned on success, build log at
   /tmp/vantra-build-t207.log on box. Box route scope refs = 11.
2. **SpaceWorker second** (hardened deploy-vps.sh, list =
   components/device-console.tsx + lib/device-tools.ts + tests×2;
   **device-onboarding.ts excluded per preflight decision 3**):
   BUILD_ID `frIasgkyQ7uJdtkZSDPQ5` → **`LV5YN3X3CbJDMU8NfNn25`**, service
   active, :3500 = 200, public spaceworker.top = 200, maintenance OFF (never
   stuck — TSTP traps held).

### Post-deploy verification (all from box + live API)
- Box greps: device-console `useIsMobileViewport` = 2, `noopener,noreferrer` = 1;
  device-tools `scope=device` = 3. ✓
- device-onboarding exclusion PROVEN: box md5 `8c87ca31befb41ad6b4ff93fb057e440`
  == local `git show agent/task-206-quarantine-rework:` md5 EXACT (the
  `ae123b47…` cited in the preflight block was a git BLOB hash, not md5 —
  same file, different hash function; corrected here). origin/main md5 differs
  (`bb8750cc…` = the old 20-min version, NOT on box). 206's 10-min machine intact.
- **Live customer curl (login → mesh-urls):** 200, `ok:true`. urls keys =
  hostname/control/terminal/file/status/client/site and **NO `login`/`meshLogin`
  keys** = the new SHARE-token mint ran (share tokens are node-bound at
  creation by MeshCentral), not the old group user-login mint.
- `scoped` flag not echoed to browser BY DESIGN: vantra returns it top-level
  (route L58 scoped:true / L69 scoped:false on loud-fallback); spaceworker
  fetchMeshUrls destructures and consumes it (backstop L182) without re-echoing.
- Failure markers absent: vantra `scoped console mint FAILED` = 0 hits /
  spaceworker `scoped:false` backstop = 0 hits in the last 10 min of journals.
- Token decode attempt: control token is not a dot-JWT (UnicodeDecodeError on
  middle segment) — shape evidence (above) used instead; share tokens cannot
  open other nodes by construction.

### Learnings (this deploy)
1. **Never `rm` the log AFTER `exec > >(tee …)`** — the rm unlinked the path;
   all script output went to an orphaned inode and was unreadable. (Deploy
   actions unaffected; verified everything via box state instead.) Rule: rm
   BEFORE opening the tee, or use `>` fresh-truncate with tee -a removed.
2. `sleep N; poll` wrapper commands exit 1 via shell-integration heuristics even
   when fine — always follow with direct file reads / box state as ground truth.

### TASK_207 STATUS NOW
- Vantra V1 committed `0f31097` + DEPLOYED. SpaceWorker S1+S2 committed
  `57be273` + DEPLOYED. S3 complete. **Only S4 open: owner live phone test**
  (user opens console on mobile → confirm new-tab launcher, no other-user
  nodes anywhere in the UI, token scoped per-device).
- QUEUE: cyberlab deploy for the other agent's work when the owner hands me
  the handoff (deploy from /Users/mikeolab/sw-lab per the established procedure).
