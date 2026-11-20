# TASK_208 — n.eko private browser on mobile: touch controls + a keyboard that works

Status: PLANNED — no code. Owner asked 2026-10-14.
Repo: spaceworker. Branch (when implementation starts): `agent/task-208-neko-mobile` off `origin/main`.
Pairs with TASK_207 (shared touch-control module — see §4).

---

## 1. What the owner reported (verbatim intent)
- "the mobile view of the private browser, it's a n.eko tool we use, so mobile users don't have a mouse to control the screen, and touching the screen moves the mouse, and also the keyboard doesn't work properly in mobile."
- "so i think a fix could go for both [shared with the console touch controls]."

## 2. What exists today (ground truth — verified 2026-10-14, real greps)

### The private browser is a same-origin n.eko iframe (unlike the console)
- `app/dashboard/browser/page.tsx:133` — `connectUrl: s.status === "running" ? connectUrlFor(s.id, s.nekoPassword) : null`.
- `lib/browser-session-serialize.ts:16-20` — `connectUrlFor` → `${APP_BASE_URL}/browser/${sessionId}/?usr=Session&pwd=<pw>&embed=1`. APP_BASE_URL is our own origin ⇒ the iframe is **same-origin**. There's a WS-upgrade reverse proxy at `/browser/<id>/`.
- `components/browser-session-panel.tsx:782-788` — `<iframe src={s.connectUrl} allow="clipboard-read; clipboard-write; autoplay; fullscreen" onLoad={hideRemoteCursorDoubling} />`.
- **Existing proof we can inject**: `components/browser-session-panel.tsx:48-58` `hideRemoteCursorDoubling(e)` reaches `e.currentTarget.contentDocument` and appends a `<style>* { cursor: none !important; }</style>` — best-effort, try/catch. This is the exact hook we extend to add touch + keyboard controls.
- No touch handling exists today (`grep onTouch/touchstart/touchmove` on the panel = empty). Neko's shipped client maps a single touch to a mouse move, which is why "touching the screen moves the mouse" without a usable click/drag, and mobile keyboards don't send key events into the canvas.

### The mobile problem, concretely
- No pointer: the user can't left/right-click, drag, or scroll reliably (one finger only moves the cursor).
- No keyboard: the on-screen keyboard doesn't reach Neko's key handling; there's no way to type into the remote browser.
- Same root cause as the console's "special controls" need — hence the shared module.

## 3. Scope (what we build)
- **P1 — Touch → mouse translation inside the n.eko iframe** (via the existing contentDocument injection, or a proxied script): one-finger drag = move cursor; tap = left-click; long-press = right-click; two-finger drag = scroll; pinch = zoom (optional). Deterministic thresholds so a tap is never mistaken for a drag.
- **P2 — An on-screen keyboard + modifier bar** injected into the iframe (or floating over it in our own DOM): a "Keyboard" toggle that opens a text input which forwards keydown/keyup (incl. Ctrl/Alt/Shift/Cmd, Enter, Tab, Esc, arrows) into Neko's input handling. This is what makes typing work on mobile at all.
- **P3 — Same-origin injection discipline**: every injection wrapped in try/catch (cross-origin/blocked must degrade to Neko's default, never break the embed — same rule as `hideRemoteCursorDoubling`). Reuse the `onLoad` hook; don't add a second iframe.
- **Out of scope**: desktop (>pointer:fine) behaviour — untouched. Any Neko server/engine change. The console (TASK_207) — only the shared module is common.

## 4. Shared touch module (the "fix could go for both")
- Build one `lib/touch-controls.ts` (or a small injected-script builder) that both TASK_208 (n.eko, same-origin) and TASK_207 (MeshCentral, only if B1 same-origin proxy lands) consume. If TASK_207 falls back to A2 + "open in new tab", this task still ships the module and uses it for n.eko alone.
- Design it embed-agnostic: given a target document/canvas + a mapping config, install touch handlers + a keyboard bridge. Unit-test the mapping logic (tap vs drag vs long-press vs two-finger) in isolation.


## 5. Plan (slices → gates → commit each)
- **S1 — Shared touch module** `lib/touch-controls.ts`: pure mapping (tap/drag/long-press/two-finger → click/move/scroll) + keyboard-bridge interface. Unit tests first, no embed wired.
- **S2 — n.eko injection**: extend `browser-session-panel.tsx` `onLoad` to install the module into the iframe's contentDocument; add the floating on-screen keyboard + modifier bar UI (in our own DOM, positioned over the iframe so it isn't fighting Neko's internal layout). try/catch degrade.
- **S3 — Live verify on a phone**: tap clicks, drag moves + selects, two-finger scrolls, the keyboard types into the remote browser, modifiers work. Desktop unchanged.
- **S4 — (conditional) Task_207 reuse**: if TASK_207 lands the same-origin MeshCentral proxy, wire the same module there.

## 6. Risks / notes (playbook §2a/§2b)
- **Injection fragility**: Neko's internal DOM/canvas can change across versions; everything must be best-effort try/catch and never break the embed (same precedent as `hideRemoteCursorDoubling`).
- **The floating keyboard overlaps the remote view** — position it in the safe area (the site already uses `env(safe-area-inset-*)`, see `device-console.tsx:3832`) and make it collapsible so it never permanently blocks the stream.
- **Same-origin assumption**: `/browser/<id>/` must stay same-origin. If a future change makes it cross-origin, injection silently stops working — add a guard/test that the connectUrl host matches APP_BASE_URL.
- **iOS Safari quirks**: `touch-action`, gesturestart zoom suppression, and keyboard focus/blur on the injected input need real-device testing (can't be fully covered by unit tests).

## 7. Gates (binding — playbooks §5/§12/§13)
- `tsc --noEmit` → 0; `eslint` touched files → 0 new; existing `test:browser` / `test:ps` stay green.
- New tests: touch-mapping unit tests (tap vs drag vs long-press vs two-finger thresholds) + a "connectUrl is same-origin" guard.
- Live on a phone: tap clicks, drag moves, two-finger scrolls, on-screen keyboard types into the remote browser, modifiers work.
- Desktop (>pointer:fine) unchanged; try/catch degrade proven (inject into a stub doc that throws → embed still loads).
- Deploy: module + keyboard UI present inside the built chunk (TASK_128 rule); no maintenance flash; rollback on build fail.
