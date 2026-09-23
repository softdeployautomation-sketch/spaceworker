# Task 103 — Console: full-screen expand, toolbox split, Ping + Reboot (owner bug log)

**Status: RECORDED — build order position #3 (after TASK_97 browser clone and
TASK_104 overlay debug). Owner-reported from live use (2026-10-01). Root causes
already traced — the fixes are small.**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §VANTRA PARITY, §ACTIVE QUEUE.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (deploy discipline), §6 (gotchas incl. the
  rsync `--files-from` + `-r` trap and "never write JSX through a shell heredoc").
- **`TASK_95_DEVICES_V2_TOOLS_PARITY.md`** — this is the follow-up layer on top
  of it (`components/device-console.tsx`, `lib/device-tools.ts`).
- **`TASK_92_ASSISTANT_FOUNDATION_AND_ENTITLEMENTS.md`** §"the ONE gate" — why
  manual own-device actions must NOT be approval-gated (approvals are for
  agent-initiated actions only; owner directive 2026-10).

---

## BUG-A — the ⤢ expand button does not give a full-screen console

**Owner report:** "the expand windows toggle you added just navigates back to
summary and also doesn't cut the other parts, i still see the same view. the
toggle should open a new tab showing only the console and our tools ... so users
see a full screen of the device."

**Root causes (both traced, both real, both independent):**

1. **The full-screen route is still inside the dashboard layout.**
   `app/dashboard/devices/[deviceId]/page.tsx` handles `?full=1` and passes
   `fullScreen` to `<DeviceConsole>`, but every route under `app/dashboard/`
   renders inside **`app/dashboard/layout.tsx` → `<Shell>`** (top menubar +
   bottom icon dock — visible in the owner's screenshots). `fullScreen` only
   hides the "← All devices" back link and the expand button itself, so the
   chrome stays.
2. **The tab resets on a fresh document load.** `components/device-console.tsx`
   has `const [tab, setTab] = useState<Tabs>("summary")`. Opening a new tab is a
   new document → tab state is re-created at `"summary"`. That is the owner's
   "it just navigates back to summary" symptom (it never *navigated*; the new
   page simply started on Summary).

**Fix (both, together):**
- **New route OUTSIDE the dashboard layout** — e.g.
  `app/console/[deviceId]/page.tsx` (top-level, no `Shell`), doing the same
  session check and rendering `<DeviceConsole deviceId fullScreen />`. The
  expand button opens **that** URL (`window.open('/console/<id>?tab=remote')`).
  Only the session window + its toolbox line render — no menubar, no dock.
- **Persist the tab in the URL** — `?tab=summary|remote|command|activity`, with
  `useSearchParams` as the initial value and `router.replace` on change (shallow,
  no scroll jump). The expand button passes the **currently active tab**, so the
  new window opens on the same view. Default when `full=1` and no `tab`: `remote`.
- Keep `?full=1` working (redirect or keep both) so links already handed out do
  not break.

**Acceptance:** from Remote control → ⤢ → the new tab shows **only** the console
and toolbox, full width/height (no dock, no menubar, no back link), landing on
**Remote control** — not Summary. Refresh preserves the tab.

---

## BUG-B — the toolbox is one long dropdown; split it into 4 grouped menus

**Owner report:** "the toolbox need to be not just one dropdown so it just goes
long on the screen, we need to separate the toolbox to maybe 3 or 4, and class
the tools to them based on their usefulness."

**Current state:** one `Tools ▾` button rendering a single `absolute ... w-56`
column (`components/device-console.tsx`, the `toolsOpen` panel) holding: Collect
PIN (4/6/8), Maintenance overlay, Stop overlay, Disconnect session. Adding Ping /
Reboot / scripts / future Browser Clone to that one column makes it unusable.

**Fix — four grouped menus on the same toolbox line** (same transparent
overlay-panel styling, each with its own open state; opening one closes the
others):

| Menu | Tools |
|---|---|
| **Session** | Connect / Disconnect, RDP Connect, Maintenance overlay, Stop overlay, *(later)* Browser Clone |
| **Power** | Reboot, Shutdown, Wake, Keep-awake *(TASK_96)*, power policy |
| **Security** | Collect PIN (4/6/8), Queue PIN collect, *(later)* credential tools |
| **Diagnostics** | **Ping agent** *(new)*, Run command (instant), Queue command, script manager |

Rationale: grouping follows *what the technician is trying to do* (open a
session / change power state / interact with the local user's credentials / probe
the machine) — how established RMM consoles group them. Item order inside each
panel must stay fixed; muscle memory matters mid-session.

**Acceptance:** 4 menus, each short; no tool needs scrolling on a 768px-tall
window; only one panel open at a time; outside-click / Esc closes.

---

## MISSING-1 — Ping button (agent connectivity check)

**Owner report:** "we need the ping button to check agent connections".

**Current state:** there is **no ping anywhere** in SpaceWorker
(`grep -i ping lib/device-tools.ts` → only a comment). Vantra's sw action route
supports `wake | reboot | shutdown | run-script | cmd`
(`app/api/internal/sw/devices/[agentId]/action/route.ts`).

**Fix:** a one-click, no-approval (manual own-device) tool in **Diagnostics**:
- New `POST /api/devices/[deviceId]/ping` → `runCommandNow` with a fast
  round-trip probe (echo a marker + timestamp), measuring **wall-clock latency to
  the agent's response**, returning `{ ok, latencyMs, agentReachable }`.
- UI shows a transient result chip: `Ping · 412 ms` (green) or
  `Agent not reachable` (amber/red). Must NOT create a queue row — a ping is not
  a command to execute later; if the device is offline it fails immediately.
- Show the heartbeat age beside it ("last check-in 42s ago") so ping and
  heartbeat tell a consistent story.

**Acceptance:** online device → latency in ms in under ~2s; offline device →
clear failure + last check-in age, no queue row created.

---

## MISSING-2 — Reboot button (and it belongs in the toolbox)

**Owner report:** "also we need the ping button to check agent connections and
reboot button, also need the reboot button in the toolbox".

**Current state:** wake/reboot/shutdown exist only on the **Devices page**
(`components/vantra-connect.tsx`, `KINDS = ["wake","reboot","shutdown"]`) and
they route through the **proposal rail** (`/api/devices/[id]/actions` →
`/api/devices/actions/[id]` approve) — i.e. a manual user must approve their own
action. That contradicts the standing rule: **manual own-device actions execute
directly; only agent-initiated actions need approval.**

**Fix:**
- Add a direct power path for manual users: `POST /api/devices/[deviceId]/power`
  `{ action: "reboot" | "shutdown" | "wake" }` → Vantra sw `action` route
  (`reboot` / `shutdown` / `wake` already supported), audited as `web-direct`
  (same pattern as maintenance start/stop and Run now).
- Put **Reboot** (plus Shutdown/Wake) in the new **Power** toolbox menu, with a
  deliberate confirm for `shutdown` (destructive if the device cannot WoL).
- Leave the proposal rail in place for **agent**-initiated power actions.

**Acceptance:** manual Reboot from the toolbox reboots the VM with no approval
prompt and writes an audit row; an agent-initiated reboot still requires approval.

---

## Non-goals
- Browser Clone UI slot (TASK_97 owns it; the toolbox reserves *Session* for it).
- Overlay shell-popup behaviour (**TASK_104**, scheduled before this task).
- Telegram approval wiring (**TASK_94**).

## Acceptance (task-level)
- Both bugs fixed as specified; Ping + Reboot live and manual-direct.
- `npx tsc --noEmit` clean; `npm run build` clean; no regression in the console.
- Deployed per `HOW_WE_MOVE_FAST.md` §2 with `--exclude='.env'`; live-verified:
  curl both new routes, then have the owner click ⤢ and each toolbox menu.

