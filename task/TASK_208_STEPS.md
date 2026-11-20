# TASK_208_STEPS.md — BEFORE / AFTER log (compaction-safe)

Running log. Read this + TASK_208_NEKO_PRIVATE_BROWSER_MOBILE_CONTROLS.md to resume.

---

## BEFORE record — 2026-10-14 (planning; NO code yet)

### Ground truth (real greps, line-verified)
- `lib/browser-session-serialize.ts:16-20` — `connectUrlFor` → `${APP_BASE_URL}/browser/${id}/?usr=Session&pwd=<pw>&embed=1`. **Same-origin** (our own domain) ⇒ injectable. WS-upgrade reverse proxy at `/browser/<id>/`.
- `components/browser-session-panel.tsx:782-788` — `<iframe src={s.connectUrl} allow="clipboard-read; clipboard-write; autoplay; fullscreen" onLoad={hideRemoteCursorDoubling} />`.
- `components/browser-session-panel.tsx:48-58` — `hideRemoteCursorDoubling(e)` reaches `e.currentTarget.contentDocument` and injects `<style>*{cursor:none !important}</style>`, try/catch. **This is the proven injection hook we extend.**
- `app/dashboard/browser/page.tsx:133` — connectUrl only set when `s.status === "running"`.
- No touch handling exists: `grep onTouch|touchstart|touchmove` on the panel = empty. Neko maps one touch → mousemove (hence "touching moves the mouse"), and mobile keyboards don't reach its key handling.
- Contrast with TASK_207 console: MeshCentral iframe is CROSS-origin (`mesh.spaceworker.top`, `lib/device-tools.ts:114-118`) ⇒ not injectable. n.eko here IS same-origin ⇒ injectable. This asymmetry is why TASK_208 is lower-risk than TASK_207.

### Findings
- Fix = inject touch→mouse (tap=click, drag=move, long-press=right-click, two-finger=scroll) + an on-screen keyboard/modifier bridge into the same-origin n.eko iframe, via the existing `onLoad`/contentDocument pattern. Build the touch mapping as a SHARED module so TASK_207 can reuse it (owner: "a fix could go for both").

### Owner decisions / open items
1. Confirm building the touch module ONCE, shared with TASK_207 (even if TASK_207 later falls back to "open in new tab" and only n.eko uses it).
2. Real-device testing required for iOS Safari focus/zoom/keyboard (unit tests can't cover it). Device must be available.

### State
- Branch to cut when implementing: `agent/task-208-neko-mobile` off `origin/main`. (Currently on `agent/task-205-link-routing-wording`; working tree has uncommitted clone-resync changes — do NOT let those ride along; see TASK_135_CLONE_RESYNC_STEPS.md.)
- Live gate BLOCKED on: a phone + a running n.eko session (device currently offline).

---

## S2 BEFORE record — 2026-10-15 (wiring + keyboard UI; S1 module done)

### Ground truth (line-verified)
- `components/browser-session-panel.tsx:782-788` — the iframe; `onLoad={hideRemoteCursorDoubling}` is the proven injection hook (line 48-58: reaches `contentDocument`, try/catch).
- `lib/touch-controls.ts` (220 lines) — `buildTouchInjectionScript()` returns the defensive IIFE; it exposes `window.__swKey(key, down, mods)` INSIDE the iframe and polls 10s for Neko's video surface. Test file `tests/agent-touch-controls.test.ts` = 14/14 pass.
- Panel file is byte-identical between `origin/main`, current HEAD, and working tree ⇒ safe to edit on a fresh `agent/task-208-neko-mobile` branch cut from `origin/main`.
- Working tree carries 2 uncommitted clone-resync files (`components/device-console.tsx`, `scripts/deploy-vps.sh`) — stash them across the branch cut, restore after, NEVER `git add` them.
- No component-test harness exists (tests are `node:test` on pure logic) ⇒ S2 adds only PURE helpers to `lib/touch-controls.ts` (sticky-modifier toggle) + their tests; the React wiring is guarded best-effort code, verified by tsc/eslint + later live phone test (S3).

### S2 plan
1. `lib/touch-controls.ts` — add pure `Mods` type + `toggleMod(mods, key)` for the sticky Ctrl/Alt/Shift bar (testable).
2. `components/browser-session-panel.tsx` — (a) `installTouchControls(e)` = cursor fix + idempotent `<script id="sw-touch-controls">` injection (guard `doc.getElementById`, survive iframe onLoad re-fires); (b) per-session iframe refs; (c) on-screen keyboard bar, only on coarse-pointer/touch devices (`matchMedia("(pointer: coarse)")` or `ontouchstart`, set in an effect — no SSR mismatch): sticky Ctrl/Alt/Shift toggles + Esc/Tab/⌫/⏎/arrows + a capture `<input>` (controlled empty, `preventDefault`, forwards `e.key` keydown/keyup into the iframe via `__swKey`) so the OS keyboard reaches the remote app. Desktop untouched.
3. Gates: `tsx --test tests/agent-touch-controls.test.ts` · `tsc --noEmit` 0 · `eslint` on both files 0-new · then commit ONLY the 3 task-208 files on the new branch.

### Owner decisions (locked)
- Fix both 207 issues (leak + UX); console UX = open-in-new-tab + reuse touch module; no re-asking.
- S3 (live phone test) stays open until a device/session is available.

---


### 2026-10-15 — S2 COMPLETE: panel wired + keyboard bar (gates green)

**Changed (3 files, committed on `agent/task-208-neko-mobile`):**
1. `lib/touch-controls.ts` (244 lines) — pure gesture logic + `buildTouchInjectionScript()`:
   same-origin IIFE injected into the Neko iframe — tap=click, drag=move, long-press=right-click,
   two-finger=scroll, plus a `__swKey(key, down, mods)` bridge for key forwarding.
2. `components/browser-session-panel.tsx` (+166/−2, 1095 total):
   - `onLoad` chains injection AFTER `hideRemoteCursorDoubling` (same-origin guarded, try/catch);
   - touch detection via `useSyncExternalStore` (server snapshot `false` → hydration-safe);
   - touch-only on-screen keyboard bar: sticky Ctrl/Alt/Shift, Esc/Tab/Backspace/Enter/arrows,
     capture-input forwarding OS-keyboard keystrokes through `__swKey` into the frame.
3. `tests/agent-touch-controls.test.ts` (126 lines, 18 tests).

**3 bugs caught by running gates during S2 (all fixed in production code):**
- NEW lint `react-hooks/set-state-in-effect` (setTouchUi-in-effect) → replaced with `useSyncExternalStore`.
- FOCUS BUG: bar container `onPointerDown → preventDefault()` blocked input focus → OS keyboard
  would NEVER open (killing the feature) → removed; capture-input receives taps normally.
- tsc noise from the uncommitted clone-resync `device-console.tsx` WIP (references task-206 `movedAt`
  which origin/main lib lacks — task-206 deployed but never merged to origin/main). Gate script now
  splits by owner. WIP NOT touched, stays uncommitted.

**GATES (all green):**
- touch tests: 18/18 pass, 0 fail
- tsc: errors_total=1 = 1 in clone-resync WIP device-console → task-208 files contribute 0
- eslint new files (lib+tests): 0
- eslint panel: current_total=3 = origin/main baseline_total=3 → 0 NEW (163/284/321 are the
  pre-existing showLocation / idleProfiles / refresh effects, line-shifted by my insertions)

**Excluded from the commit (still uncommitted WIP):** `components/device-console.tsx` (clone resync),
`scripts/deploy-vps.sh` (hardening), all TASK_*.md docs, scripts/.

**Remaining:** S3 live phone verify (needs an active n.eko session; 207 device also offline).
Then TASK_207 per owner decision: BOTH issues fixed — leak (real fix is Vantra-side per-user mesh
scoping; in-repo: hide tree + open-in-new-tab UX) and mobile UX = open new tab reusing this touch module.

---

## 2026-10-14 — S4 DEPLOY: TASK_208 SHIPPED (AFTER record)

**Commit:** `362c6a7` branch `agent/task-208-neko-mobile` (3 files). Deploy = working tree
file list via hardened `scripts/deploy-vps.sh` (no schema change -> no db push needed).

**Preflight (script `scripts/t208-preflight.sh`, all clean):**
- box `browser-session-panel.tsx` hash = EXACT origin/main (`3a8fa6503e3e1062`) -> zero shared-file
  drift, plain rsync safe (no merge needed, unlike clone's device-console case).
- box had NO `lib/touch-controls.ts` -> sibling trap averted by putting BOTH files on the list;
  `touch-controls.ts` confirmed self-contained (0 imports).
- marker for built-chunk verify: string literal `sw-touch-controls` (survives minification).
- BUILD_ID before: `XrE6sqfVBRo-7je8cYC-A` (cyberlab egress deploy).

**Deploy list (3 files):** components/browser-session-panel.tsx, lib/touch-controls.ts,
tests/agent-touch-controls.test.ts.

**Deploy run:** rsync -> chown -> prisma generate -> maintenance ON -> rollback copy -> BUILD OK
(full log /root/last-build.log; deploy log /tmp/t208-deploy.log) -> restart -> preservation checks
(.env .next node_modules maintenance.html all ok) -> maintenance OFF -> done. No freezes
(trap hardening held), no missing-module errors (pre-flight closure check).

**VERIFY (all green):**
- BUILD_ID `frIasgkyQ7uJdtkZSDPQ5` (was `XrE6sqfVBRo-7je8cYC-A`) | service active | maint OFF
- `localhost:3500` 200 | `https://spaceworker.top/` 200
- marker `sw-touch-controls` found INSIDE built static chunks (1 file) -> touch code shipped in bundle
- box hashes == local hashes for BOTH files (panel `a9fb1fde06965d44`, touch `3f255e043010128d`)

**Owner note:** grant testing on cyberlab is the owner's (admin panel). 208 live test (S3) still
owes a phone session against an active n.eko. Next: TASK_207 (both issues locked, no re-ask).

