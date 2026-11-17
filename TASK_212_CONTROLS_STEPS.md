# TASK_212 STEPS — Controls everywhere: mouse controller, embedded new-tab controllers, landscape+portrait

Task doc: `TASK_212_CONTROLS.md` (owner asked 2026-10-15).
Repo: `/Users/mikeolab/spaceworker`. Branch: `agent/task-212-controls`.
Agent: task agent (no deploy — box work is the deploy agent's, per PROMPT §1).

---

## BEFORE — 2026-10-15 (task agent)

### 1. Branch state + absorb-merges (TASK_212 §5, executed)

- Working tree clean of tracked files at start (`git status --porcelain | grep -v '^??'` → 0 lines). Untracked: TASK_211 docs + this file.
- Base = local `main` = `5ef85a8` (unchanged since TASK_211; `origin/main` `a1704b4` IS an ancestor — local main is 20 commits ahead).
- Created `agent/task-212-controls` from `5ef85a8`.
- **Merge 1**: `git merge --no-ff agent/task-207-console-scope` (`57be273`) → **clean, NO conflicts** (merge commit `a6a946d`): browser-session-panel.tsx +168, device-console.tsx +111, lib/device-tools.ts +26, lib/touch-controls.ts +244 (new), lib/device-onboarding.ts +6, scripts/deploy-vps.sh +14, 3 test files.
- **Merge 2**: `git merge --no-ff agent/task-208-neko-mobile` (`362c6a7`) → **"Already up to date"** — 208 is an ancestor of 207 (verified `git merge-base --is-ancestor`); merge 1 absorbed it. Provenance recorded in merge-1 message. Any future build from this branch keeps the box's touch controls + mesh scope.
- 207's tip also carries `e1314a8` (clone-lib resync + deploy script hardening, already deployed per its message) — rides along, not a clobber risk.

### 2. Shared-file clobber watch (PROMPT §3.1)

In-flight: `agent/task-210-deploy-tooling` (= main tip, no extra commits), `agent/task-211-mesh-input` (`bf8ec8b` — ONLY `scripts/t211-mesh-input-*.sh`, verified `git show --stat`), 207/208 (now merged IN). Files this task edits: `components/browser-session-panel.tsx`, `components/device-console.tsx`, `lib/touch-controls.ts`, NEW `app/browser-popout/[sessionId]/*`. No overlap with 210/211; 207/208 content already in-branch → no loss possible. ✅

### 3. File-grounded findings (line numbers on THIS branch post-merge; re-grep before citing)

#### The private browser (n.eko, same-origin iframe via `/browser/<id>/` proxy)

- `components/browser-session-panel.tsx:815-832` — "Open in new tab ↗" does `window.open(s.connectUrl!, "_blank", "noopener,noreferrer")` = the RAW neko URL (built server-side in `lib/browser-session-serialize.ts:16-21`, `usr/pwd/embed=1`). A popped tab gets NO SpaceWorker chrome, no touch controller, no keyboard bar → **D3 root cause**. `poppedOutIds` (`:335-340`, `:818`, `:826`, `:834-854`): opening the tab pauses the embed; "Reconnect here instead" resumes. Keep that semantics.
- `:857-876` — embed `<iframe src={s.connectUrl} onLoad={installTouchControls}>` then the `!readyIds` overlay `absolute inset-0 … bg-black` (`:868-875`). **D1 root cause**: the overlay is the ONLY element covering the iframe — opaque, inset-0, default `pointer-events: auto` — so for the whole 6 s grace window (`readyTimers` `:341-352`, `setTimeout(…, 6000)`) every click lands on the overlay, not the remote desktop. The iframe beneath is already loaded and interactive (`:326-333`). Fix: overlay `pointer-events-none` (visual only) so the first screen passes clicks through immediately.
- `:49-80` — `hideRemoteCursorDoubling` + `installTouchControls` (208): idempotent (`#sw-touch-controls`), try/catch degrade — the precedent for D2's bridge.
- `lib/touch-controls.ts` (244 lines, from 208) — pure logic + `buildTouchInjectionScript()` IIFE; already exposes parent→iframe `window.__swKey(key, down, mods)` (`:221-231`) — the pattern D2's `window.__swMouse` bridge follows.
- Keyboard bar (panel `:881-960`) lives INSIDE the panel component only → popped tab has no keyboard either (owner: "the controllers are not present in the open in new tab").


#### The device console new tab

- `app/console/[deviceId]/page.tsx:35-39` — `?tab=` aliases, default `control`; `<DeviceConsole fullScreen initialTab>`; chrome-free by design (TASK_103).
- `components/device-console.tsx:1663-1692` — the ENTIRE tab strip is `fullScreen && "hidden"` → **D4a root cause**: no tool tab is reachable in fullScreen (only the control body renders, `:1725-1728`). Owner: new tab "doesn't come with the spaceworker tools".
- `:3926-3962` — TASK_207 mobile launcher card: `isMobileViewport && !embedInPage` renders a card ("Open remote console" → `window.open(mesh.control, …)`) INSTEAD of the iframe, on ANY surface including fullScreen. A phone opening `/console/<id>?tab=control` sees only this card; its button opens the RAW MeshCentral URL → the owner's D4 report verbatim. Fix: in fullScreen bypass the launcher card (embed directly — the card exists to avoid the cramped 70dvh dashboard embed, which fullScreen is not).
- `:3964-3985` — mesh iframe `src={mesh.control}`, `sandbox="allow-scripts allow-same-origin allow-forms"`, `fullScreen ? "min-h-0 flex-1" : "h-[70dvh] sm:h-[480px]"`. Cross-origin: `mesh.control`'s host is rewritten to `mesh.spaceworker.top` (lib/device-tools.ts:106-140) — different origin than the app → our JS cannot touch MC's DOM (sandbox `allow-same-origin` keeps MC's OWN origin; it does not make it same-origin with us).
- `:3301-3311` — `useIsMobileViewport` = `(max-width: 639px)`, useSyncExternalStore, server=false — pinned by tests/console-mesh-scope.test.ts; keep the shape.
- ⚠ TASK_211's STEPS cited the launcher card at `:3843-3846`; on this branch it is `:3926-3962`. Every prior citation treated as a hint; all re-grepped.

#### D4b investigation — why the DeskControl "Input" row is unreachable (evidence)

1. MC iframe is cross-origin → no DOM injection (unlike the neko embed).
2. Upstream research 2026-10-15: MeshCentral documents NO parent→iframe postMessage API (GitHub #4461, #2533, official docs — only `allowframing` + login-token URL embedding exist).
3. Vantra repo live-verified note (`/Users/mikeolab/vantra/lib/meshcentral-api.ts:19-22`): "MeshCentral has NO per-URL `viewonly` flag … View-only is enforced server-side only through device share links" → URL-param tricks can't drive input state; TASK_212 §4 also bans `input`/`view` params.
4. The `Input` checkbox is MeshCentral's OWN DeskControl row; TASK_211 (box-side) already flipped its DEFAULT to unchecked via nginx sub_filter.
5. Conclusion: an "our-DOM toggle driving MC's DeskControl" is NOT achievable repo-side. Surviving option per TASK_212 §2: **surface MC's own checkbox** — give the iframe the full remaining viewport in fullScreen (D5) so MC's toolbar with the Input checkbox renders at reachable size, plus a hint row pointing at it. If MC still hides it at phone widths, the honest lever is box-side (TASK_211 sub_filter precedent) → hand back to the deploy agent, never guessed here.

#### D3 design decision (route vs param)

Wrapper route `app/browser-popout/[sessionId]/page.tsx` (server component) chosen over `?url=`: the connectUrl embeds credentials (`usr/pwd`) — a query param would leak them into browser history, Referer headers and logs. A server route re-mints the URL from the DB after `getSession()` + ownership check (`BrowserSession.userId`, schema `:1306-1336`), so credentials never appear in client-provided strings. Same-origin guard preserved trivially: the route builds the iframe src from `connectUrlFor` (APP_BASE_URL) itself. Client applies the same defensive `installTouchControls` on load; on throw, the raw stream still works (degrade precedent).

### 4. Baseline gates (merged branch, before edits)

`npx tsc --noEmit` + `npx tsx --test tests/*.test.ts` launched in background (logs `/tmp/t212-tsc-base.log`, `/tmp/t212-tests-base.log`) — results verbatim in AFTER §2.

## AFTER — 2026-10-16 (task agent)

### 1. What was implemented — D1…D5 (9 files, uncommitted on `agent/task-212-controls`)

**Branch record (§5):** created from `main` = `5ef85a8`; one `--no-ff` merge `a6a946d` ("merge TASK_207 (57be273, includes TASK_208 362c6a7) per TASK_212 §5"). Verified: both `57be273` (207) and `362c6a7` (208) are ancestors of HEAD — the single merge satisfies "absorb BOTH" because 207's history already contains 208; no standalone 208 merge commit exists on the branch (path used: absorbed-via-207, per its own merge message). No conflicts needed resolving.

**Files (4 modified + 5 new):**

- **D1 — first-screen overlay stops eating the mouse** · `components/browser-session-panel.tsx`
  The opaque start/grace overlay (inset-0, bg-black) got `pointer-events-none` (:807) — it was visual-only intent, but ate clicks/moves for its whole window while the already-loaded iframe sat underneath. Owner bug "first screen doesn't let the user use the mouse".

- **D2 — on-screen MOUSE controller** · `lib/touch-controls.ts` (+120) + new `components/remote-viewer-controls.tsx` (353)
  Pure pad logic in touch-controls (React/DOM-free, testable): `PadCursor/PadBounds`, `PAD_SPEED = 1.5` (phone trackpad ≪ remote desktop), `PadSpec` (move/down/up/wheel), `clampCursor`, `padMoveSpecs` (scaled, NaN-safe, zero-delta → nothing), `padClickSpecs`, `padDoubleClickSpecs`, `padDragSpecs` (press=down / release=up, moves keep button held), `padScrollSpecs` (±120 wheel notch). Injection script gained `window.__swMouse` (:334): realm-local virtual cursor clamped to the frame's own surface rect — the parent sends only relative deltas/button commands, never needs frame geometry; same defensive try/catch posture as `__swKey`. The component `RemoteViewerControls` renders the pad (move surface, Left/Right/Double/Drag/▲▼) + TASK_208's keyboard bar (mods, Esc/Tab/⌫/⏎/arrows, capture-only type-in), touch-only (`pointer:coarse`), collapsed by default, safe-area aware. `installTouchControls` (cursor-doubling fix + injection) moved here VERBATIM from the panel → one installer, zero fork.

- **D3 — pop-out tab carries the controllers** · new `lib/browser-popout.ts` (42), `app/browser-popout/[sessionId]/page.tsx` (89), `components/browser-popout-view.tsx` (45) + panel wiring
  `popoutHrefFor(id)` / `isSameOriginConnectUrl(url, base)` (pure; unparseable → false, never embed blind). Server route: `getSession()` → `redirect("/login")`; ownership-scoped `findFirst({ id, userId: session.sub })` → `notFound()` for other users' ids (same as GET /api/browser-sessions/[id]); `status !== "running"` → friendly dead-end card; re-mints `connectUrlFor(id, nekoPassword)` from the DB (credentials NEVER ride a `?url=` param — history/Referer/log leak rationale, §3 D3); applies the same-origin guard before rendering. View: `100dvh` flex column, safe-area `max()` padding, iframe `flex-1 min-h-0`, `onLoad={installTouchControls}`, controls BELOW the stream (never covering it), desktop → component renders null. Panel's "Open in new tab ↗" now opens `popoutHrefFor(s.id)` (:748) instead of the bare Neko URL; `poppedOutIds` behaviour unchanged.

- **D4a — full-screen new tab shows the SpaceWorker tool tabs** · `components/device-console.tsx`
  The strip was `fullScreen && "hidden"` (TASK_103 NEW-2 intent: chrome-free). Now one compact row in full-screen: `fullScreen && "shrink-0 px-2 py-1"` (:1689) + `text-xs whitespace-nowrap overflow-x-auto` (scrolls sideways in landscape, never steals height). Title bar still hides (:1629 — TASK_103 chrome kept, deliberate). Embedded strip byte-identical. Remote stays default tab → first paint unchanged, one slim strip taller.

- **D4b — Input checkbox: honest hint, NOT a fake toggle** · `device-console.tsx`
  Dismissible one-line hint (:3978, `isMobileViewport && fullScreen && !inputHintDismissed`, state :3410, × dismiss): "Mouse & keyboard control is MeshCentral's own **Input** checkbox, in the toolbar at the top of the screen…" — research (BEFORE §2) proves no repo-side toggle is possible (no MC postMessage API, no URL-param enforcement, §4 bans `input`/`view` params); box-side default already flipped by TASK_211. Plus launcher-card bypass (:4006): `isMobileViewport && !embedInPage && !fullScreen` — full-screen embeds directly at `min-h-0 flex-1` with the toolbox line above, so MC's toolbar + Input checkbox get the whole remaining screen; the TASK_207 prefix stays verbatim for tests/console-mesh-scope.test.ts (that test passes).

- **D5 — orientation-agnostic full-screen layout** · `app/console/[deviceId]/page.tsx` (:46) + `device-console.tsx`
  Height moved UP to the page: `flex h-[100dvh]` + `max(1.5rem/1rem, env(safe-area-inset-*))` on all four sides (`viewportFit: "cover"` already set in app/layout.tsx) — desktop byte-identical margins (max() falls back to py-6/px-4 when insets are 0). Console outer div + window card became `flex min-h-0 flex-1 flex-col` in full-screen; ControlTab's screen container: old `flex h-[calc(100vh-3rem)] flex-col` replaced by `flex min-h-0 flex-1 flex-col` — NO viewport calc anywhere, so portrait AND landscape both fill exactly with the keyboard/toolbar showing or not.

- **New unit tests (§6 binding)** · `tests/task-212-controls.test.ts` — 25 tests: popout href shape/encoding + same-origin guard (7), D2 pad thresholds/spec shapes/NaN-clamping/`__swMouse` markers (12), D1/D3/D4/D5 source-contract pins following console-mesh-scope precedent (6).

### 2. Gates (post-edit, verbatim — §6)

- **`npx tsc --noEmit` → 0** — `grep -c 'error TS'` = **0**, `TSC_EXIT=0` (`/tmp/t212-tsc.log`). Includes the new test file.
- **`npx tsx --test tests/*.test.ts` → 0 fail** — `# tests 1538 / # pass 1537 / # fail 0 / # skipped 1`, `SUITE_EXIT=0` (`/tmp/t212-tests.log`). The 1 skip is the known DB-gated baseline test (identical at baseline). Arithmetic check: baseline (`/tmp/t212-tests-base.log`) 1513 + 25 new = **1538** → zero regressions, all new green. New file alone: 25/25 (`/tmp/t212-newtest3.log`).
- **`npx eslint` (all 9 changed/added files)** → **0 new problems.** The only findings are 3 × `react-hooks/set-state-in-effect` in `components/browser-session-panel.tsx` (104:28, 203:5, 240:5) — PROVEN pre-existing: linting the HEAD version of that file (`git show HEAD:… > baseline-probe-212.tsx`) yields the **same 3 errors** (probe :104/:284/:321); probe file deleted, tree clean. Method precedent: `scripts/t205-lint-baseline.sh`. All 8 other files incl. the new test: 0 problems (`/tmp/t212-eslint-new.log`).
- **New unit tests (§6 item 3)** → satisfied: builder+guard ✓, orientation/layout contract ✓, D2 gesture thresholds ✓ (25 tests above).

### 3. Decisions & deviations the verifier should know

1. **No fake Input toggle** (D4b): research in BEFORE §2 + §4's param ban leave a pointer-to-MC's-own-checkbox as the only honest repo-side surface. If MC still hides its checkbox at phone widths, that's a box-side question (TASK_211 sub_filter precedent) → hand back to the deploy agent, never guessed here.
2. **Pad cursor lives in the FRAME realm** (`__swMouse` clamps to `getBoundingClientRect()`), not the parent — parent stays geometry-free; a Neko surface resize can't desync it.
3. **`clampCursor` treats non-finite input as invalid → 0** (not "clamp toward far edge") — matches `padMoveSpecs`' NaN policy; pinned by test with an explicit message.
4. **Title bar still `fullScreen && "hidden"`** (line 1629) — TASK_103 chrome intent kept; only the TAB STRIP was un-hidden (D4a). The test pins the strip's own region, deliberately scoped.
5. **Desktop (>pointer:fine) unchanged except D1** (§4): `RemoteViewerControls` renders null without touchUi; pop-out tab on desktop = stream in our wrapper (auth+ownership+guard) exactly as before, no new chrome.
6. **Layout = source-contract tests, not behavioural** — browser-only facts (100dvh, safe-area, strip visibility) follow the console-mesh-scope.ts precedent; pins are class tokens whose removal must be a conscious edit.
7. **No commits made** — §5: "commit ONLY when the verification/deploy agent instructs". Working tree: 4 modified + 5 new (mine; other untracked scripts/docs belong to other tasks, untouched).

## HANDOFF → VERIFICATION AGENT

**Scope:** repo-only. No VPS/box/nginx/DB work (§4) — nothing to deploy yet; deploy agent runs after review (§6 last bullet).

**Repo/branch:** `/Users/mikeolab/spaceworker` · branch `agent/task-212-controls` · HEAD `a6a946d` (= `main` `5ef85a8` + absorb-merge of 207/208) · **changes uncommitted** (commit on your instruction per §5).

**Files to review/ship (9):** modified `components/browser-session-panel.tsx`, `components/device-console.tsx`, `lib/touch-controls.ts`, `app/console/[deviceId]/page.tsx`; new `lib/browser-popout.ts`, `components/remote-viewer-controls.tsx`, `components/browser-popout-view.tsx`, `app/browser-popout/[sessionId]/page.tsx`, `tests/task-212-controls.test.ts`.

**Automated gates (rerun to confirm):**
```
cd /Users/mikeolab/spaceworker
npx tsc --noEmit                      # expect exit 0, 0 "error TS"
npx tsx --test tests/*.test.ts        # expect 1538 tests, 0 fail (1 known DB skip)
npx eslint <the 9 files>              # expect 0 new problems (3 known panel errors — see AFTER §2)
```

**Manual acceptance (§6, cannot be faked — dev server `npm run dev`, logged-in user, Neko session running):**
1. **Desktop first-screen mouse:** open an embedded private-browser session; during the black start/grace overlay, click + drag IMMEDIATELY → actions reach the remote desktop (D1 overlay is `pointer-events-none`).
2. **Phone in-page controller:** phone/touch device, session card → the shared controller strip appears (collapsed by default) → expand: pad move moves remote cursor (×1.5), Left tap clicks, Right right-clicks, Double double-clicks, Drag+slide drags, ▲▼ scroll; keyboard bar modifiers + arrows + type-in reach the frame (D2).
3. **Pop-out tab:** "Open in new tab ↗" → `/browser-popout/<id>` (view address bar — NO credentials in URL) shows the stream WITH the same touch controller + keyboard on a phone; desktop shows stream only. Logged out → `/login`; another user's session id → 404; stopped session → "has ended" card (D3).
4. **Full-screen new tab:** `/console/<id>` on phone → compact one-line SpaceWorker tool tab strip (Remote default, switch tabs); title bar absent (TASK_103) (D4a); hint row "…MeshCentral's own Input checkbox…" visible once, × dismisses, MC toolbar with Input checkbox reachable above the screen (D4b).
5. **Orientation (both mobile surfaces — embed view + `/console` full-screen):** portrait AND landscape → screen fills the viewport edge-to-edge under notch/home-indicator, no dead strip at the bottom, toolbox line + tabs reachable; repeat with on-screen keyboard open/close (D5).
6. **Degradation:** if injection throws, stream still plays with old touch behaviour (try/catch precedent) — never a blank/broken embed.

**STOP-and-report triggers (§7):** any manual step failing from a cause NOT in TASK_212 §2 candidates; anything needing box access (hand to deploy agent); any merge/branch surprise before commit.



