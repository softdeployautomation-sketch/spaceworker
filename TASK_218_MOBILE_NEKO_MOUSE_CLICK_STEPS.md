# TASK_218 — Mobile n.eko mouse click not reaching neko's control — STEPS

Owner: task agent. Branch: `agent/task-218-mobile-neko-mouse`, cut from **local main `16bd2df`**.
Commit policy: ONE commit when instructed (PROMPT §3.2) — **uncommitted at handoff**.
Task doc: `/Users/mikeolab/TASK_218_MOBILE_NEKO_MOUSE_CLICK.md` (D1 pop-out restore, D2 mobile
tap-through, D3 dead-end honesty, D4 tests/gates, D5 handoff).

## BEFORE — 2026-10-17 (task agent)

### 0. Pre-work required by the task doc (done first)
- **TASK_217 committed** as ONE commit **`0061836`** on `agent/task-217-lan-audit` (12 code
  files; `TASK_217_LAN_AUDIT_PROTOCOL_STEPS.md` left untracked per PROMPT §3.2). 217 is
  **left unmerged** — senior deploys 217+218 together.
- **Branch cut from local main**: `main` is **checked out by another worktree**
  (`/Users/mikeolab/sw-vbsfix`), so `git checkout main` is refused. Cut 218 **from the
  `main` ref** instead ⇒ HEAD == `16bd2df` == main (verified in `scripts/s218-branch.out`).

### 1. Branch / tree state
- Base `16bd2df` (t220). `git log fe3e717..main --oneline --stat` = **only two commits**:
  `27334d5` (t219 → `lib/hosting/rules.ts`, `HOW_WE_MOVE_FAST.md`, `tests/hosting-files.test.ts`)
  and `16bd2df` (t220 → hosting links/campaigns/schema/package.json).
  **Zero browser/neko/popout files changed since 216** ⇒ confirms the task's grounding.
- `package.json` diff `fe3e717..main` = **only two test-script additions**; **no dependency
  bumps** ⇒ T220 cannot explain a hydration/chunk regression.

### 2. File-grounded findings (line numbers on base `16bd2df`)
Control path (D1):
- `components/browser-popout-view.tsx:42-44` mounts `<RemoteViewerControls>` **unconditionally**
  below the iframe in an `h-[100dvh]` flex column (iframe `min-h-0 flex-1`, controls
  `shrink-0`) — no gate, no CSS path that can hide it on desktop.
- `components/browser-session-panel.tsx:822` mounts it **unconditionally** for
  `s.status === "running" && s.connectUrl && !poppedOutIds.has(s.id)`.
- `components/browser-session-panel.tsx:737-760` — "Open in new tab ↗" opens
  **`popoutHrefFor(s.id)`** (wrapper route), NOT the bare neko URL. Pinned by
  `tests/task-212-controls.test.ts:177-184`.
- `app/browser-popout/[sessionId]/page.tsx` — `force-dynamic`; gates in order:
  `redirect("/login")` (:40), `notFound()` on ownership miss (:50), `status !== "running"`
  dead-end (:56-70), same-origin guard (:80-90). Only then `BrowserPopoutView`.

**H7 opener re-audit (every `window.open` / `target="_blank"` in the repo):**
| Site | Opens | Verdict |
|---|---|---|
| `components/browser-session-panel.tsx:747` | `popoutHrefFor(s.id)` | correct |
| `components/device-console.tsx:1674` | `/console/${deviceId}?tab=…` | not neko |
| `components/admin/devices-tab.tsx:779` | `${adminPath}/device/${id}` | not neko |
| `components/device-console.tsx:1582` | `data.openUrl` = **raw neko URL** (clone flow) | **bare-neko opener** |
- `components/device-list.tsx` — **no** browser/neko/popout opener (grep clean).
- Clone chain: `lib/clone-hosted-launch.ts:457` `viewUrl: connectUrlFor(sessionId, nekoPassword)`

### 3. Root-cause verdicts (with evidence)

**D1 (pop-out card missing on desktop) ⇒ H5, no code regression.**
Both mounts unconditional; no browser file changed `fe3e717..main`; pop-out opener uses the
wrapper route; the only pre-216 behaviour that produced "stream, zero controls" was the
**removed** `touchUi`/`pointer: coarse` gate (documented verbatim in
`components/remote-viewer-controls.tsx:13-17` and `browser-popout-view.tsx:36-41`).
⇒ A tab opened on the pre-216 build (or restored from bfcache/history) keeps that DOM until
hard-reload; a post-216 deploy that rotated `.next` also strands its chunks.
**Acceptance step (post-deploy, mine + owner's): hard-reload Cmd+Shift+R the pop-out tab.**
H6 ruled out for the owner's case: every non-stream screen prints an explicit line (D3
tightens the one that was still ambiguous).

**D2 (mobile taps don't reach neko) ⇒ H1/H3, ONE root cause in the injection script.**
The touch listeners are bound **once** (to the video if it appears within 10 s, else to
`document.body`). On mobile the neko `<video>` mounts only after the WebRTC handshake —
routinely > 10 s — and is frequently **remounted** (renegotiation / orientation change / tab
resume). Either way the live video ends up with **no listeners**, so every touch is handled
against `body`: the synthetic mouse events are then dispatched with `body` as their
**target**, and an event targeted at `body` never traverses neko's video subtree — so
neko's own input listeners never see it. The **pad was immune** because `__swMouse` resolves
`surface()` **fresh on every call** (that asymmetry is the proof: pad works, taps don't).
Desktop is unaffected because its video mounts inside the 10 s window and never remounts.
- H2 **ruled out**: neko's control model is mouse-based; we already emit
  mousedown/mouseup/click/dblclick/contextmenu/wheel, and `preventDefault()` on the real
  touch already suppresses the browser's own synthetic mouse events.
- H4 **ruled out by inspection**: `setPointerCapture`/`releasePointerCapture` act on the
  pad's own element (`e.currentTarget`, `remote-viewer-controls.tsx:194/216`); pointer capture
  is per-document and cannot cross into a cross-document iframe, so the pad can never steal a
  touch that starts on the stream.
- H1 (coords) real but **secondary**: coords round-trip correctly *for whatever element is
  bound* (map + unmap share the same rect), so the mapping only misleads when the wrong
  element is bound — fixed by the same change.

### 4. Baseline gates
Task doc D4 baseline = **1612/1611/0/1** (post-T220; the pre-217 docs quoting 1588 are stale).
Verbatim BEFORE capture recorded in AFTER alongside the AFTER results.

---

  → `app/api/clones/[cloneId]/session/route.ts:58` `openUrl: row.viewUrl` →
  `components/device-console.tsx:1581-1582` `window.open(url, "_blank", "noopener")`.
  Also `components/clone-session-view.tsx:178-179` = **bare `<iframe src={openUrl}>` with no
  `RemoteViewerControls` and no `installTouchControls`**.
- **Clones cannot ride the pop-out wrapper**: `app/browser-popout/[sessionId]/page.tsx:46-50`
  auths via `prisma.browserSession.findFirst({id, userId})`, but the only
  `browserSession.create` in the codebase is `app/api/browser-sessions/route.ts:174/182`;
  `lib/browser-runtime.ts` has **no prisma usage at all** ⇒ clones own no `BrowserSession`
  row ⇒ routing clones through `popoutHrefFor` would 404 into the H6 dead-end.
  **Not silently patched — reported to senior** (needs a design decision + `device-console.tsx`,
  which TASK_217 also modified).

---

## AFTER — 2026-10-17 (task agent)

### 1. What shipped

**D2 — mobile tap-through (root-cause fix, `lib/touch-controls.ts`, injection script only — the
pure half is untouched, so TASK_208/212/216 unit logic is byte-identical):**
- **Capture-phase binding on `document`** — `install(document)` + `{ passive: false, capture: true }`.
  The old bubble listeners on `document.body` never fired on mobile because Neko's own touch
  handlers stop propagation on the stream/container; capture runs before any descendant can
  stop the event. Binding at `document` also works before `<body>`/the video exist.
- **`surface()` never falls to body while media exists** — `return best || nodes[0] || document.body;`.
  A late/remounted mobile video can have a zero-area box; a mouse event dispatched at `body`
  never traverses the video subtree, so Neko's `<video>` listeners never saw the tap.
- **Per-event dedup** — `seen()` stamps `e.__swTouchSeen`; with document + body + surface all
  bound, one touch is translated exactly once (outermost point wins).
- **No-give-up rebind watcher** — the old `40 × 250 ms` poll is replaced by a permanent cheap
  `setInterval(…, 1000)` so a video that mounts after the WebRTC handshake or remounts later
  (rotation / tab resume) is always bound.
- **Neko's own chrome stays native** — `isNekoControl(e.target)` skips BUTTON/A/INPUT/SELECT/
  TEXTAREA and `role=button|link|menuitem|menu` subtrees so the new capture binding cannot
  hijack Neko's menu taps (they'd be re-aimed at the remote desktop and preventDefault'd).
  The remote desktop is pixels in `<video>` — never a button — so a stream tap can't be skipped.
- H2 (event types) and H4 (pointer capture) remain **ruled out** per BEFORE §3; no changes.

**D1 — pop-out restore (H5 = stale tab, no code regression):**
`components/browser-popout-view.tsx` gains a `pageshow`/`persisted` guard — a tab restored from
the back/forward cache (pre-deploy DOM, WebRTC dead while frozen) reloads itself once. Both
mounts verified unconditional (pins in the new test). Post-deploy acceptance step still applies:
**hard-reload (Cmd+Shift+R) the owner's existing pop-out tab once.**

**D3 — dead-end honesty:**
`app/browser-popout/[sessionId]/page.tsx` dead-end now reads "session has ended — the stream and
the mouse & keyboard controls are only available while it runs. Close this tab and start a new
session from the dashboard." The embedded paused-after-pop-out placeholder (`browser-session-panel.tsx:764-783`)
was judged unambiguous and left as-is.

**D4 — tests:** `tests/task-218-mobile-neko.test.ts` (11 tests): capture binding, media-over-body
dispatch, dedup in all three handlers, no-give-up watcher, native-chrome skip, TASK_216
retryability regression pin, bfcache guard pins, both mounts' pins, both dead-end wordings.

### 2. Gates

| Gate | BEFORE | AFTER |
|---|---|---|
| `tsc --noEmit` | 0 | **0** |
| full suite | **1612 / 1611 / 0 / 1**, exit=0 | **1623 / 1622 / 0 / 1**, exit=0 |
| eslint (4 touched files) | n/a | **exit 0** |

New tests: +11 (task-218 suite). No existing test edited.

### 3. Deviations / open items

1. **H7 clone chain still reported, NOT patched** (unchanged from BEFORE §): clones own no
   `BrowserSession` row so they can't ride `popoutHrefFor`; `device-console.tsx:1582` opens the
   raw clone URL and `clone-session-view.tsx` renders a bare iframe. Needs a senior design
   decision + touches `device-console.tsx`, which TASK_217 also modified.
2. **Owner-acceptance items (cannot be unit-tested):** real-device mobile taps (embedded +
   pop-out), desktop pop-out card visible after hard-reload, Neko hamburger menu still opens
   natively on mobile after the capture-phase change — all listed for the post-deploy pass.
3. `seen()` marks events even when the touch is skipped by `isNekoControl` — intentional: the
   skip must apply to every bound node, not just the first.

