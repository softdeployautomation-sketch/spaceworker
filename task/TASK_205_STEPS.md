# TASK_205 STEPS — Hosting editable Desktop-only wording + "link"→"file" + Desktop/Mobile split destinations

Playbook: `HOW_WE_MOVE_FAST.md`. Plan: `TASK_205_HOSTING_DESKTOP_ONLY_EDITABLE_WORDING.md` (EXPANDED 2026-10-14 to add Part B — platform-split destinations).
**This file is the senior standoff.** Update BEFORE any code (BEFORE record) and AFTER every slice (PROGRESS). Real greps only; never assume.

Repo: **`spaceworker`** (`/Users/mikeolab/spaceworker`). **Branch (to be cut at implementation): `agent/task-205-link-routing-wording` from `origin/main`** (TASK_205 shares ZERO files with the in-flight `agent/task-206-quarantine-rework`, so it rebases cleanly off main). HEAD at planning: `cb8ec7b`. Newest migration on `origin/main`: `20261121000000_task203_device_monitor_price` — the new migration MUST be strictly greater.

---

## BEFORE record — 2026-10-14 (planning complete, EXPANDED for Part B, no code yet)

### Ground truth verified (real greps, 2026-10-14)
- Desktop-only gate = **TASK_175**, premium-only (`canUseDesktopOnlyGate`, `links.ts:151`). Schema `LinkRedirect`: `target String` (single destination) + `desktopOnly Boolean?`; **no wording column AND no second/mobile destination column exist**.
- Interstitial copy is **hard-coded in two places**, must stay identical:
  - `lib/hosting/links.ts:626 desktopOnlyInterstitialHtml` (local `/r`).
  - `lib/hosting/workers.ts:782 WORKER_DESKTOP_GATE_SNIPPET` (edge Worker; stringified, dependency-free).
  - Body today: `This link opens best on a desktop computer. Please open it on your PC to continue.`
- Resolver: `app/r/[token]/route.ts:38-52` → `resolveLink` (`links.ts:581`) returns `{id,target,desktopOnly}`; desktopOnly+mobile+no-bypass ⇒ interstitial, else 302 to `target`. Mobile check `isMobileUserAgent` (`:601`).
- Edge map: `buildWorkerMapSource` (`workers.ts:799`) emits `MAP` (key→target) + `DESKTOP` set; `WorkerMapEntry={key,target,desktopOnly?}` (`:763`); entries built in `mapEntriesFor` (`links-engine.ts:127`, selects token/slug/target/customHost/desktopOnly, one entry per token AND slug).
- Validation `isValidLinkTarget` (`lib/hosting/rules.ts`): http/https only.
- Create checkbox `components/hosting-panel.tsx:~1467-1478`; per-link toggle `~:1546-1554`; both premium-gated. Create API `links.ts:230`; update `UpdateHostedLinkInput :329`; cloudflare edit re-publishes at `:445-489`. View model `HostedLinkView`/`toHostedLinkView` (`:65`).
- Tests: `tests/hosting-desktop-gate.test.ts` + `tests/hosting-workers.test.ts`; runner `npm test` = `tsx --test tests/*.test.ts`.

### Owner decisions locked (do NOT re-litigate)
- **Part A** — Editable wording = per-link, button **beside** the Desktop-only select (create form + per-link row). Premium-only. Fields = **Title + Body** only; `Continue anyway` + `On a desktop?` note stay fixed.
- "link" → "file" applies to the **desktop-only interstitial body** (both copies). Tab label / "Short links…" / "served by a Cloudflare Worker" / "Create link" are **out of scope** (flagged, not assumed).
- **Part B (NEW)** — Split destinations: user gives a **desktop link + mobile link**, we hand back ONE `/r/<token>` redirect that routes each platform to its own target. Dynamic (decided at open time) + optional (NULL mobile = today's single-target). Three flows on one model: single · split · desktop-only gate. **Precedence: split wins over the interstitial** when `mobileTarget` is set. Two buttons beside the desktop-only select: "Edit wording" + "Split by device".
- **Premium default (owner-confirmable):** Part B reuses `canUseDesktopOnlyGate`. If the owner wants split FREE, drop that one check — a one-line change, flagged not assumed.

### Branching / deploy discipline
- Cut `agent/task-205-link-routing-wording` from `origin/main` (shares zero files with TASK_206). VPS deploy = shared prebuilt build per HOW_WE_MOVE_FAST §2 (tar-over-ssh; verify by md5 both ends; never `git log` on the box). Requires owner go-ahead before any VPS action.
- Migration timestamp strictly greater than `20261121000000` (newest on `origin/main`): `git fetch origin; git ls-tree --name-only origin/main prisma/migrations/ | tail -3`. Proposed `20261122000000_task205_link_routing_and_wording` (ONE migration for all three nullable columns).

## PROGRESS

### 2026-10-14 — A1 DONE (schema + migration). `prisma validate` PASS 🚀. Added 3 nullable cols to `LinkRedirect`: `desktopTitle String?`, `desktopBody String?`, `mobileTarget String?` (schema L1595-1607). Migration `prisma/migrations/20261122000000_task205_link_routing_and_wording/migration.sql` — 3 `ADD COLUMN … TEXT`, additive only, matches schema 1:1. Timestamp `20261122000000` > floor `20261121000000` (confirmed). migrate-diff needs live shadow DB → deferred to deploy (TASK_128). Next: A2 local render + B2 edge render.


### 2026-10-14 — SCOPED (Part A wording + Part B split, planned A1/B2/A3+B3/A4+B4/A5/A6, no code). Plan doc §3. Awaiting go-ahead to implement.

---

## IMPLEMENTATION START — 2026-10-14 (owner go-ahead)

Owner locked (verbatim): keep Desktop-only **editable**; add **split to two links**; leave everything **premium**.
Branch `agent/task-205-link-routing-wording` cut from `origin/main` @ `a1704b4`. Migration floor `20261121000000` confirmed via `git ls-tree origin/main prisma/migrations`.

### Implementation ground truth (exact, real reads)
- `lib/hosting/links.ts`: `HostedLinkView.desktopOnly:boolean` (L47); `LinkRedirectRow` (L50-63, `desktopOnly?:boolean|null` L62); `toHostedLinkView` (L65, reads `row.desktopOnly===true` L86). `CreateHostedLinkInput` (L102, `desktopOnly?` L117); create mint premium-drop (L246-249); create data spread `...(desktopOnly===true?{desktopOnly:true}:{})` (L284). `UpdateHostedLinkInput` (L329, `desktopOnly?` L341); update persist (L422-428: true→premium-check, false→null); `mapChanged` includes `data.desktopOnly!==undefined` (L445). `ResolvedLink` (L558-564, `desktopOnly:boolean`); `resolveLink` (L581, returns `{id,target,desktopOnly}` L586-590). `desktopOnlyInterstitialHtml(continueUrl)` (L626-656): title `<title>Open this on your PC</title>` (L637) + `<h1 id=t175-title>` (L644), body `<p>This link opens best on a desktop computer…</p>` (L645); `esc`=HTML-escape L627; `js`=JS-string escape L632.
- `lib/hosting/workers.ts`: `WorkerMapEntry={key,target,desktopOnly?}` (L763-770); `WORKER_DESKTOP_GATE_SNIPPET` (L782-783, one long line, `t175IsMobile`+`t175Gate(key,url,ua)`); `buildWorkerMapSource` (L799-828) emits `const MAP`, `const DESKTOP=new Set([...])`, snippet, then fetch handler: `DESKTOP.has(key)` gate (L820-823) before `Response.redirect(target,302)` (L824).
- `lib/hosting/links-engine.ts`: `mapEntriesFor` (L127-162) selects `token,slug,target,customHost,desktopOnly`; pushes `{key:token,target,desktopOnly:gated}` + slug twin (L158-159); return type inline `{key,target,desktopOnly:boolean}[]`.
- `lib/hosting/rules.ts`: `isValidLinkTarget` (L379-386) http/https only.
- `app/r/[token]/route.ts`: GET (L19-53); bypass `?desktop=1` (L37); desktopOnly branch (L38-45); final `NextResponse.redirect(link.target,302)` (L52).
- `components/hosting-panel.tsx` (1661L): `HostedLink` iface (L66-85, `desktopOnly?` L84); `HostingStatus.desktopOnlyAllowed?` (L62); `linkForm` state (L179-189, `desktopOnly:false` L188); create body sends `desktopOnly` (L668); reset (L676-684); `onToggleDesktopOnly` (L745-770); create-form checkbox (L1467-1478); per-link toggle (L1546-1554) + badge (L1555-1559).
- Tests: `tests/hosting-desktop-gate.test.ts` harness = fake prisma + `Module._load` hook + `require("../lib/hosting/links.ts")` + `require("../lib/hosting/workers.ts")`. `tests/hosting-workers.test.ts` also present. Runner `npm test` = `tsx --test tests/*.test.ts`.

### Slice order (implementing): A1 schema+mig → A2 wording render → B2 split render → A3/B3 API → A4/B4 UI → A5 copy → A6 gates+deploy.


### 2026-10-14 — A2 (local render) + B2 (edge Worker entry type) DONE. Code (uncommitted, gated at A6):
- `lib/hosting/links.ts` — added to `HostedLinkView`: `desktopTitle/desktopBody/mobileTarget: string|null` (L51-57); `LinkRedirectRow` gained the 3 optional cols (L73-78, optional so old Prisma client compiles); `toHostedLinkView` maps them (empty→NULL, L106-109); `CreateHostedLinkInput` +3 (L143-148); create premium-drop extended — one `canUseDesktopOnlyGate` call when any of the 4 gate features requested, `mobileTarget` validated `isValidLinkTarget` else dropped (L282-300); create data spread +3 `...(x!==undefined?{x}:{})` (L340-342); `UpdateHostedLinkInput` +3 (L403-408); update persist: set=premium-only, clear=any-owner, invalid mobile dropped (L497-526); `mapChanged` +3 (L546-548); `ResolvedLink` +3 (L667-673); `resolveLink` returns them empty→NULL (L708-714).
- NEW exports for one-source-of-truth copy: `DESKTOP_INTERSTITIAL_DEFAULT_TITLE`/`_BODY` (L747-749, body now says **"file"** not "link" — owner ask) + `escHtml()` helper (L755-757). `desktopOnlyInterstitialHtml(continueUrl,title?,body?)` now HTML-escapes custom copy into `<title>`,`<h1 id=t175-title>`,`<p>` (L751-...); defaults when NULL/empty. **XSS-safe**: untrusted owner wording escaped same as continueUrl.
- `app/r/[token]/route.ts` — added split branch BEFORE the desktop-only branch: `if(link.mobileTarget && !bypassed && isMobileUserAgent) → NextResponse.redirect(link.mobileTarget,302)` (L38-41). **Split WINS over interstitial.** Interstitial call now passes `link.desktopTitle, link.desktopBody` (L56).
- `lib/hosting/workers.ts` — `WorkerMapEntry` gained `desktopTitle?/desktopBody?/mobileTarget?` (L772-777).
- NEXT: B2 remainder — `WORKER_DESKTOP_GATE_SNIPPET` (emit `MOBILE` map + read custom copy) and `buildWorkerMapSource` (parallel MOBILE + COPY maps + split branch in fetch handler); then `mapEntriesFor` (links-engine.ts) to select+push the 3 cols.



### 2026-10-14 — B2 COMPLETE + gate note. Edge Worker + engine done:
- `lib/hosting/workers.ts` — `WORKER_DESKTOP_GATE_SNIPPET` now has `t175Esc()` + `t175Gate(key,url,ua,copy)`; the 3 hard-coded copy spots (`<title>`,`<h1>`,`<p>`) now interpolate escaped `tEsc`/`bEsc` (defaults when copy absent). `buildWorkerMapSource` builds parallel `MOBILE` (key→mobileTarget) + `COPY` (key→[title,body]) maps, emits `const MOBILE`/`const COPY`, and the fetch handler runs the **split branch BEFORE the gate** (`MOBILE[key] && t175IsMobile(ua)` → redirect mobile), then `t175Gate(key,url,ua,COPY[key])`. Split WINS over interstitial, matching the local `/r` route.
- `lib/hosting/links-engine.ts` `mapEntriesFor` — return type + both `select`s + both pushes now carry `desktopTitle/desktopBody/mobileTarget`; defensive cast `row as {…}` (same pattern desktopOnly uses) so a stale live Prisma client compiles.
- **GATE NOTE:** after editing schema.prisma, `npx prisma generate` is REQUIRED before tsc passes (the `select` clause is strictly type-checked against the generated `LinkRedirectSelect`; the defensive cast only covers the read side). `npx tsc --noEmit` → **0 errors** post-generate.
- NEXT: A4/B4 UI in `components/hosting-panel.tsx` (2 buttons beside desktop-only select + create-form + per-link row), then A6 tests + gates.


### 2026-10-14 — A4/B4 UI + A6 TESTS COMPLETE + GATES GREEN. Full slice order done (A1/A2/B2/A3/B3/A4/B4/A5/A6 except deploy):
- `components/hosting-panel.tsx` — `HostedLink` +3 fields; `linkForm` +3; `editingRoutingFor`/`showWording`/`showSplit` state; create body + reset send/clear the 3 fields; NEW `onSaveRouting` PATCH callback (premium-drop notice); NEW top-level `RoutingEditor` component (seeded inline editor + live "Desktop→X · Mobile→Y" preview); create-form "Edit wording" + "Split by device" buttons beside the desktop-only checkbox; per-link "Routing" button + "split" badge + `<RoutingEditor>` render.
- `app/api/hosting/links/route.ts` (POST) + `app/api/hosting/links/[id]/route.ts` (PATCH) — zod schema +3 (`desktopTitle/desktopBody` max 200/500, `mobileTarget` max 2048, all `nullable().optional()`), passed to create/update. Server owns premium-drop + URL validation.
- `tests/hosting-desktop-gate.test.ts` — +16 TASK_205 tests: custom-copy mint (premium persists / free dropped), XSS escaping of title+body, "file" not "link" default, empty→default fallback, wording update set/clear, split mint+resolve, NULL single-target, free split dropped, invalid `javascript:`/`data:` dropped on mint+update, split+gate coexistence, edge MOBILE+COPY maps + split-branch-before-gate + "file" edge copy + empty-MOBILE.
- **GATES (all green):** `npx tsc --noEmit` = **0** · eslint = **1 error, PRE-EXISTING** (`hosting-panel.tsx:373` `void loadStatus()` effect — was baseline line 281, only shifted by my +76-line RoutingEditor; proven untouched via `git diff -U0` hunks) → **0-new** ✓ · hosting tests **80/80 pass** (64 baseline + 16 new).
- **NOT deployed** (deliberate — shares `schema.prisma` with cyberlab; see coordination note below). Committed to branch only.
- **Deploy coordination (CRITICAL):** task-205 shares `prisma/schema.prisma` (+3 `LinkRedirect` cols) with cyberlab (`+LabTarget.sourceDeviceId`). Single schema file → last deploy wins → loser's cols vanish from baked client → runtime 500s. Order: (1) commit task-205 on branch, DO NOT deploy; (2) deploy cyberlab from `sw-lab` (independent, task-205 not on box); (3) task-205 deploys only after its schema is MERGED to include cyberlab's `sourceDeviceId`. Handoff: `/Users/mikeolab/sw-lab/HANDOFF_CYBERLAB_UI1_DEPLOY.md`.


---

## TASK_205 DEPLOY — 2026-10-14

### BEFORE (real checks)
- Branch `agent/task-205-link-routing-wording` @ `e2f7c48`, 10 files (+792/-23).
- **SCHEMA COLLISION (predicted):** task-205 schema has desktopTitle/desktopBody/mobileTarget but LACKS cyberlab `sourceDeviceId`; box has sourceDeviceId but lacks the 3. Rsync of task-205 schema.prisma as-is would WIPE sourceDeviceId.
- **FIX: merged schema** = box schema + task-205's 3 LinkRedirect cols. Verified LinkRedirect has all of desktopTitle/desktopBody/mobileTarget/target/desktopOnly; LabTarget.sourceDeviceId preserved.
- Box: 110 migrations, newest `20261121000000_task203`; task-205 `20261122000000` newer (no collision). Live LinkRedirect lacks the 3 cols.
- task-205 migration.sql = 3 additive nullable TEXT ALTERs.

### Deploy sequence (NO db push --accept-data-loss; additive SQL via psql):
1. scp merged schema -> box; prisma generate.
2. Apply 3 ALTERs via psql -v ON_ERROR_STOP=1 (idempotent-guarded).
3. rsync task-205 code (excl. schema.prisma) + migration dir.

### ✅ 2026-10-14 — TASK_205 DEPLOYED & VERIFIED (BUILD_ID fsMwhzRBaQUP6lGbh1KQF)
- service active; :3500 = 200; public = 200; maintenance OFF.
- Code live: mobileTarget×21 in links.ts, desktopTitle×13 in hosting-panel.tsx.
- DB LinkRedirect has all 3 task-205 cols (desktopTitle/desktopBody/mobileTarget).
- **CyberLab sourceDeviceId = 1 (preserved — schema collision avoided via merged schema).**
- Single schema.prisma (prisma/).

### Deploy method (clean, no db push):
1. Merged schema = box schema (cyberlab-complete) + task-205's 3 LinkRedirect cols → scp to box.
2. prisma generate (reads prisma/schema.prisma; orphan root gone).
3. Applied 3 additive ALTERs via psql -v ON_ERROR_STOP=1 (idempotent-guarded) — NOT db push.
4. rsync 10 files (excl. schema.prisma; + lib/hosting/rules.ts which task-205 imports and box was stale on) + migration dir via hardened deploy-vps.sh (trap TSTP fix held, no freeze).
5. build(rollback) + restart + verify.

**Import-closure pre-check caught the cyberlab-style trap early:** task-205 imports lib/hosting/rules.ts (box-stale) → added it (== origin/main, closure size 1, safe). lib/prisma.ts already matched box (deployed in cyberlab fix).

**Both features now live together:** CyberLab UI-1 + TASK_205 link routing/editable wording. No regressions, no data loss.

4. build(rollback) + restart + verify :3500 200 + new BUILD_ID.
