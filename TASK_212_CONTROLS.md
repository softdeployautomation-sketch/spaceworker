# TASK_212 — Controls everywhere: mouse controller, embedded new-tab controllers, landscape+portrait

Status: PLANNED — no code. Owner asked 2026-10-15.
Repo: spaceworker (`/Users/mikeolab/spaceworker`). Branch: `agent/task-212-controls` (see §5 — it MUST absorb `agent/task-208-neko-mobile` first).
Related: TASK_208 (touch gestures + keyboard — DONE and DEPLOYED), TASK_207 (mobile console), TASK_211 (mesh Input default — box-side nginx, owned by the deploy agent, **off-limits to this task**).

---

## 1. Owner's report (verbatim intent, 2026-10-15)

- "The private browser in mobile you fixed, we already have an issue with **the first screen not letting user use the mouse in that screen**, that's why we always use the open in new tab for desktop"
- "you **didn't add a mouse controller** for the mobile"
- "the controllers are **not present in the open in new tab**, the open in new tab for the mobile should be embedded with the controllers, we need a good mouse controller"
- "we need all to work well in **landscape mode on mobile and in portrait**"
- Device console: "opening in another tab is fine though but **doesn't come with the spaceworker tools**, and **no place to check or uncheck input**"

→ Five deliverables: **D1** (first-screen mouse), **D2** (mobile mouse controller), **D3** (controllers in the pop-out tab), **D4** (device-console new tab: tools + input toggle), **D5** (landscape + portrait everywhere).

## 2. Ground truth (verified 2026-10-15 by the deploy agent — line numbers are volatile, RE-GREP before citing in STEPS)

### The private browser (n.eko, same-origin iframe)

- `components/browser-session-panel.tsx:747` — "Open in new tab ↗" button (`:743-757`) does `window.open(s.connectUrl!, …)` = the **raw neko URL** (`${APP_BASE_URL}/browser/<id>/?usr=Session&pwd=…&embed=1`, from `lib/browser-session-serialize.ts:16-20`). A new tab therefore gets **no SpaceWorker chrome, no touch controller, no keyboard bar** — those live only inside the panel component. `poppedOutIds` (`:743-779`) pauses the embed when popped; keep that semantics.
- `:782-788` — the embed `<iframe src={s.connectUrl} onLoad={hideRemoteCursorDoubling}>`.
- `:789-796` — full-cover `absolute inset-0 bg-black` "Connecting your browser…" overlay while `!readyIds` — a **candidate** for the first-screen mouse blocker, but DO NOT assume: reproduce on desktop with devtools first and document the actual blocking element in STEPS BEFORE.
- TASK_208 S1+S2 shipped touch gestures + on-screen keyboard: `lib/touch-controls.ts` + panel wiring, branch `agent/task-208-neko-mobile` @ `362c6a7`, **already deployed on the box** (`/opt/spaceworker/lib/touch-controls.ts` present, `installTouchControls` ×2 in the deployed panel) but **NOT merged into local `main`** (`git cat-file -e main:lib/touch-controls.ts` fails). Any build from local main today would silently REVERT the box's touch controls — §5 fixes that.

### The device console new tab

- Route `app/console/[deviceId]/page.tsx:38` → `<DeviceConsole fullScreen initialTab>` — chrome-free by design (TASK_103).
- In `fullScreen` the **entire tab strip (all tool tabs) is hidden**: `components/device-console.tsx:1661-1667` — this is why the new tab "doesn't come with the spaceworker tools". The session-tools toolbox line above the iframe stays (`:3920-3925` copy).
- MeshCentral iframe in-page: `:3899-3917` (`h-[70dvh] sm:h-[480px]`, sandbox `allow-scripts allow-same-origin allow-forms`).
- `window.open` surfaces in this file: `:1568` (clone session) and `:1646` (expand → `/console/<id>?tab=…`, title "Open the console alone in a bigger window").
- ⚠ TASK_211's STEPS cite a launcher card at `device-console.tsx:3843-3846` ("Open remote console" → `window.open(mesh.control)`) — our greps this session did NOT find it (only `:1568`/`:1646`; `mesh.control` only at `:3899`). Treat every line citation as a hint, not truth.

### The Input checkbox (MeshCentral `DeskControl`)

- The auto-check DEFAULT is fixed by TASK_211 **on the box** (nginx `sub_filter` on both mesh vhosts) — deploy agent's territory, **this task never touches `/etc/nginx`, mesh vhosts, or adds `input`/`view` URL params** (repo invariant, TASK_211 §2: the client only ever forwards `?scope=device`).
- TASK_212's part is SURFACE ONLY: the owner reports the new-tab console has **"no place to check or uncheck input"**. Investigate why the `DeskControl` row is not reachable in that surface (mobile viewport? our iframe sandbox? MC's own responsive hiding?) and make it reachable — by surfacing MC's own checkbox, or an our-DOM toggle that drives MC's `DeskControl` state, whichever survives investigation. No URL params either way.

## 3. Scope — deliverables (each gets a slice + gate)

- **D1 — First-screen mouse (private browser, desktop).** Reproduce (desktop, fresh profile, embedded view), identify the exact blocking element with devtools, fix so the mouse works on the very first screen. Record root cause in STEPS BEFORE. No other desktop behaviour change.
- **D2 — Mobile mouse controller (in-page).** A real on-screen mouse controller for touch: left-click, right-click, drag/move mode, scroll (wheel buttons or two-finger passthrough), double-click — built on `lib/touch-controls.ts` (extend it, don't fork). Shown only on touch (`isTouch`/`pointer:coarse` heuristics already in the module), collapsed by default, `env(safe-area-inset-*)` aware, never permanently covering the stream, usable one-handed.
- **D3 — Controllers inside Open-in-new-tab (private browser).** The pop-out must land on a surface carrying the same controller + keyboard. Preferred design: our own wrapper route (e.g. `app/browser-popout/[sessionId]/page.tsx`) that renders OUR chrome (controller + keyboard + safe areas) around the raw connectUrl iframe; choose route-vs-param in the plan and justify. Constraints: popped-out session still pauses the embed (existing `poppedOutIds` flow keeps working); `/browser/<id>/` WS proxy untouched; same-origin guard (connectUrl host === `APP_BASE_URL`) preserved — TASK_208 gate precedent.
- **D4 — Device-console new tab.** (a) Bring the SpaceWorker **tool tabs** into `/console/<id>` fullScreen in a compact form that respects the TASK_103 chrome-free intent — state the design decision and why it doesn't regress desktop. (b) A visible, working **check/uncheck Input** control in that surface (see §2 last block — investigation first, no URL params).
- **D5 — Landscape + portrait (all surfaces).** Private-browser embed, pop-out wrapper, and `/console/<id>` must both work in both orientations on a phone: no overflow, controls reposition via orientation/resize handling, `dvh` sizing, iframe fills. Both orientations are a manual acceptance gate.

**Branch context found at scoping time (verify, don't trust):** `agent/task-207-console-scope` @ `57be273` = TASK_207 S1+S2 ("scoped mesh mint client + mobile new-tab console UX" — the mobile launcher card + `?scope=device`) — also NOT merged into local `main`. So the box currently runs code from BOTH task-207 and task-208 branches that local `main` lacks. Record both branch states in STEPS BEFORE.

## 4. Non-goals

- No box/nginx/MeshCentral changes (TASK_211, deploy agent only). No `input`/`view` URL params ever.
- No Vantra changes, no `prisma/schema.prisma` changes, no DB steps.
- No neko server/engine changes. Desktop (>pointer:fine) behaviour unchanged except D1.
- TASK_207 territory beyond D4's tools/input visibility is out of scope (its branch content must be absorbed per §5, not rewritten).

## 5. Branch & sequencing (SHARED working tree — coordinate, commit only when instructed)

- The working tree is shared with other agents. Before any switch: `git status --porcelain | grep -v '^??'` must be empty (untracked TASK/STEPS docs are safe to leave).
- Expected base: local `main` (record `git rev-parse --short HEAD`; was `5ef85a8` at scoping time). Create `agent/task-212-controls` from it.
- **Then absorb the deployed-but-unmerged work** (without it, any future build from `main` reverts the box):
  1. `git merge --no-ff agent/task-207-console-scope` (`57be273` — mesh scope + mobile launcher card),
  2. `git merge --no-ff agent/task-208-neko-mobile` (`362c6a7` — touch gestures + keyboard; branched off `origin/main` `a1704b4`).
  On conflict (most likely `components/browser-session-panel.tsx` / `components/device-console.tsx`) → keep main-side history + the task branch's feature, record the resolution verbatim. If a merge is rejected outright, fall back to `git cherry-pick <sha>` of the branch tip. Record which path was used for each.
- Clobber watch — shared files this task will likely edit: `components/browser-session-panel.tsx` (208 + D1/D2/D3), `components/device-console.tsx` (207 + D4), `lib/touch-controls.ts` (D2), plus NEW popout route files. Record per-branch diffs of every shared file in STEPS §3.1 before editing (PROMPT rule).
- Commit each slice; **commit ONLY when the verification/deploy agent instructs** (owner rule for this batch). No push. No deploy — deploy agent owns all box work.

## 6. Gates (binding)

- `npx tsc --noEmit` → 0 (if stale-client `TS2339`s appear, `npx prisma generate` first — precedent TASK_211 AFTER §2).
- `npx tsx --test tests/*.test.ts` → 0 fail (baseline 2026-10-15: 1489 pass / 1 DB-gated skip; `tests/console-mesh-scope.test.ts` from 207 must stay green).
- New unit tests: pop-out target builder (wrapper route + same-origin guard), orientation/layout logic, any new gesture thresholds in D2 (reuse/extend TASK_208's tests).
- Manual/owner acceptance (cannot be faked): desktop first-screen mouse works; phone in-page controller (click/right-click/drag/scroll) works; pop-out tab has controller + keyboard; `/console` new tab shows tools + a reachable Input toggle; **both** landscape and portrait on both mobile surfaces; embed still degrades cleanly if injection throws (try/catch precedent `hideRemoteCursorDoubling`).
- Deploy: performed by the deploy agent after review (components present in built chunk, BUILD_ID bump, maintenance-off).

## 7. Handoff format

`TASK_212_CONTROLS_STEPS.md` — BEFORE / AFTER / HANDOFF sections exactly like `TASK_211_MESH_CONNECT_INPUT_AUTOCHECK_STEPS.md`. STOP-and-report on any deviation from this doc (unexpected branch state, merge refusal you can't resolve per §5, a first-screen root cause that isn't in §2's candidates, or anything requiring box access — box questions get handed back to the deploy agent, never guessed).

