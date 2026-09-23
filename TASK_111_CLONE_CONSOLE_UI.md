# Task 111 (bit B5) — Clone console UI (tab + card + session window)

**Status: NOT STARTED.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B5**). Depends on **B4** (`TASK_110`) + **C2** (`TASK_103`).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2 (deliverable 8).

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-111-clone-ui`, push.
> **Do not** deploy, ssh the VPS, touch `.env`, or run `prisma migrate deploy`.
> **Never write JSX through a shell heredoc** — use the file editor and then check
> the brace balance / run `tsc` (§6; this exact trap already corrupted this file once).
> Full rules: `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** — **authoritative**. Placement (5th tab +
  Summary card + **new-tab** session), the per-clone record/history fields, the three
  launch modes and the hidden-window findings. **Do not improvise placement.**
- **`DESIGN_DEVICES_PAGE.md`** — console copy rules and tab conventions.
- **`HOW_WE_MOVE_FAST.md`** §0–§3, **§6**.
- **`TASK_103_CONSOLE_FULLSCREEN_TOOLBOX_SPLIT_PING_REBOOT.md`** — the full-screen
  session window pattern this must reuse (a real chrome-free route, **not**
  `?full=1` inside `app/dashboard/layout.tsx`, which still renders the shell).
- **`components/device-console.tsx`** (tabs, polling, `cleanErr`), `components/ui.tsx`
  (the shared primitives), `components/device-list.tsx` (status/idle rendering).

## Deliverables

1. **New console tab** — add `["clone", "Browser clone", …]` to `TABS` in
   `components/device-console.tsx`, rendering a `CloneTab` component.
2. **Summary card** — on the Summary tab: clone status line
   (`inactive · last clone 2 Sep, expired`), an **Open cloned browser** button
   (enabled only while a session is live) and **Manage clones →** linking to the tab.
3. **`CloneTab` contents:**
   - **Start**: browser picker (Chrome / Edge / Firefox), profile picker, and the
     **egress mode** picker — *Same IP as your PC* (`relay`, default) vs
     *SpaceWorker's IP* (`direct`, shown **locked** with a Premium note when the user
     lacks it; the server is the real gate).
   - **Live state**: current lifecycle step in human words, elapsed time, TTL
     remaining, and **relay health** when in relay mode.
   - **Controls**: Open session · Revoke · (Delete on terminal rows only).
   - **History**: newest-first rows with **date**, browser/profile, status,
     **egress mode**, TTL/expiry and error text. Terminal `failed` rows show the
     reason, never a bare "failed".
4. **Session window** — a real chrome-free route (e.g. `app/clone/[cloneId]/page.tsx`
   at top level, **outside** `app/dashboard/`), opening in a **new tab**: the hosted
   browser plus its own thin toolbar only. If `TASK_103`'s pattern has landed, reuse
   it verbatim rather than inventing a second mechanism.
5. **Polling** — refresh clone status on the console's existing interval; do not add
   a second independent timer, and pause while the document is hidden.

## Copy rules (owner-visible quality bar)

- **Human language only** — `Waiting for your PC` / `Copying your browser` /
  `Ready` / `Session expired`, never `awaiting_source`, `stagingRef`, or an id.
- **Egress must be unambiguous** — `Same IP as your PC` vs
  `SpaceWorker's IP — sites may ask you to sign in again`.
- **Fail-closed is explained, not hidden** — relay down in relay mode shows *why* and
  offers the direct path (for those entitled to it) rather than a dead button.
- **Never render an upstream body**; route errors through the console's existing
  `cleanErr` so no HTML or `vantra_503:` prefix reaches the UI.

## Out of scope

- Any server logic (`TASK_108`–`TASK_110`) — you consume the routes only.
- Toolbox changes and Ping/Reboot (`TASK_103`), overlay fixes (`TASK_104`).

## Acceptance (owner runs after deploy)

- `tsc --noEmit` clean; local `npm run build` green; no console errors on load.
- Tab renders for a device with **no** clone history (honest empty state) and with history.
- Starting a clone shows each lifecycle step progressing without a manual refresh.
- Direct-egress picker shows locked for a non-premium user and the server **also**
  refuses it if forced.
- Relay-down state produces the explained failure, not a silent downgrade.
- **Open session opens a new tab with no dashboard nav/chrome**; closing it does not
  kill the session, and Revoke does.
- Delete appears only on terminal rows and removes the row from the history.
- Nothing on the tab prints a raw enum, id, path or upstream error body.

## Report back

Files changed · `tsc` result · screenshots or a described walkthrough of each state ·
anything unverified.
