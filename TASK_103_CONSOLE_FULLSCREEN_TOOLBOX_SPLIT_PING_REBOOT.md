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

## MISSING-3 — Hide agent tool (Command tab; owner request 2026-09-24)

**Owner request:** "add a tool as well, maybe in command tab, to hide the
installed agent so users don't mistakenly stop the service or uninstall it.
The agent can test the installed agent in the VM to see the names when
search and how to rename it to something like microsoft services or any
name users want. The point is to be able to run a command to hide the
agent, but needs to be dynamic for each device."

**Intent (read carefully):** reduce *accidental* discovery/stop/uninstall by
a curious local user — NOT a security boundary against a determined local
admin. Anyone with local admin can undo every step below in seconds. The
tool must say so in its own output, and must always offer the exact reverse.

**Research findings (do NOT re-litigate; implement from this):**
- Upstream TacticalRMM position (maintainer `wh1te909`, discussion #1389):
  "don't give your users admin access … any workaround … will just be
  overridden by anyone who has admin." There is NO supported
  password-protect-uninstall / uninstall-token mechanism.
- Community approach that survives agent updates (user `adamjrberry`, same
  thread, endorsed by the maintainer): set the `SystemComponent` DWORD to
  `1` on the agent's uninstall registry key. The entry disappears from
  "Apps / Programs and Features" (Settings search no longer surfaces it)
  while the MSI uninstall path still works for someone who knows where to
  look. Reported to persist across agent updates. No service rename
  involved, so agent check-in / TRMM upgrades are unaffected.
- DisplayName rebrand is cosmetic-only and safe: `Set-Service -Name
  '<internal>' -DisplayName '<label>'` changes ONLY what `services.msc` /
  Task Manager show. The internal service `Name` NEVER changes — there is
  no supported internal rename short of reinstall. Do NOT attempt one.
- MeshAgent service name is NOT stable/assumed: the community
  `Win_TRMM_Mesh_Install.ps1` resolves it at runtime via `Get-CimService`
  rather than hardcoding. So the script MUST discover the Mesh service
  dynamically on-device (wildcard `Mesh Agent*` on Name/DisplayName, probe
  known TRMM-laid names as fallback), and report exactly what it found.

**VM ground truth the agent MUST capture first (Windows VM, real install):**
1. `Get-Service tacticalrmm, "Mesh Agent*" | Format-Table Name,
   DisplayName, Status` — exact internal Names + current DisplayNames.
2. `Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' |
   Where-Object { $_.DisplayName -match 'Tactical|Mesh' } |
   Select-Object DisplayName, DisplayVersion, UninstallString, PSChildName`
   — exact uninstall key(s) the tool will stamp.
3. Settings → Apps search terms that surface the agent today
   (e.g. `tactical`, `mesh`) — before/after notes, so "hidden" is proven.
   Paste all three into the commit/PR message.

**Fix (one tool, dynamic per device, reversible):**
- Command-tab one-click **"Hide agent"** (+ companion **"Reveal agent"**)
  next to Ping. Manual own-device, no approval; audited as `web-direct`
  with the chosen label + per-step results.
- Transport: reuse `POST /api/devices/[deviceId]/run-command`
  (`runCommandNow`, powershell, ≤90s) — NO new route, NO new Vantra action
  kind. The ONLY per-device dynamic input is the **display label**,
  default `Microsoft System Services`, free-text override (validate
  server-side: 1–80 chars, letters/digits/spaces/`-` only).
- Script behaviour (best-effort per step, echo `STEP:<name>
  OK|SKIP:<reason>`; end with honesty line `NOTE: cosmetic only — a local
  admin can still stop/reveal/uninstall; use Reveal to undo.`):
  1. `Get-Service tacticalrmm` (hard fail → `agent_service_missing`,
     change nothing); Mesh via wildcard match (SKIP if absent).
  2. `Set-Service -Name '<found>' -DisplayName '<label>'` each found
     service. NEVER touch internal Name, StartupType, or Status.
  3. `SystemComponent=1` (DWORD) on each discovered uninstall subkey only
     (matched by the recorded pattern — never blanket-stamp the hive).
  4. Re-read DisplayName(s) + SystemComponent value(s) and print them.
- **Reveal agent** is the exact inverse (restore DisplayName `Tactical
  Agent` / recorded Mesh original + remove `SystemComponent`) and is
  REQUIRED in the same release — ship both or ship neither.
- Confirm dialog names the label and the cosmetic-only limit; output shows
  in the Command-tab result pane, persisted only via the audit row.

**Out of scope (do NOT build):** uninstall passwords/tokens, ACL-ing the
service, blocking `sc.exe`/Task Manager, renaming the internal service
name, touching StartupType/Status, hiding files on disk, anything that
would survive an intentional admin uninstall.

**Acceptance (VM, per device):** before, Settings search
`tactical`/`mesh` surfaces the agent and `services.msc` shows `Tactical
Agent` (+ Mesh); after Hide, search finds nothing, services show the
label, `Get-Service tacticalrmm` still exists/running, device stays online,
uninstall key has `SystemComponent=1`; custom label applies + audits;
Reveal restores + re-hide works (idempotent); offline → immediate failure,
no queue row (same rule as Ping).

---

## 2026-09-25 — AMENDMENT: BUG-A is only half fixed; sharper requirement + a new, real bug found

**Owner report (live use, browser-clone-paused session):** "when I click the
expand, all I want is for the mesh screen to grow bigger to fit the screen
and just the one line for our tools with it. Apart from that, nothing else
should show — even the PIN request modal shouldn't be in the remote, since
it's already in the tools." Also: switching Remote control → Summary → back
to Remote control shows "Unable to perform authentication" / "Server
disconnected, click to reconnect" on a session that was working seconds
earlier.

**Verified against the current deployed code (not guessed):**

1. **The chrome-free route IS live** — `app/console/[deviceId]/page.tsx`
   exists, is deployed (`curl https://spaceworker.top/console/<id>` → `200`,
   confirmed present in `/opt/spaceworker/.next/server/app/console/`), and
   correctly hides the dashboard `<Shell>` (back link, top menubar, bottom
   dock) via `fullScreen`. **BUG-A's route half is done.** Two things it does
   NOT do, which is what the owner is actually hitting now:

2. **NEW-1 — the mesh iframe has a hardcoded height and never grows.**
   `components/device-console.tsx`'s iframe is
   `className="h-[480px] w-full bg-black"` — a fixed 480px regardless of
   window size, so opening the chrome-free full-screen route does NOT make
   the actual screen bigger, which is the owner's literal, repeated
   complaint. **Fix:** in `fullScreen` mode, the iframe must fill the
   available viewport height (flex-grow layout or `h-[calc(100vh-<toolbar
   height>)]`), not a fixed pixel value. Non-fullscreen (embedded-in-tab)
   view can keep a fixed height — this is a `fullScreen`-conditional change.

3. **NEW-2 — full-screen still renders the ENTIRE console (tab strip +
   other tabs + PinPanel), not just the mesh screen + one toolbar line.**
   `app/console/[deviceId]/page.tsx` renders the SAME `<DeviceConsole
   fullScreen>` as the embedded view — full tab strip (Summary / Remote
   control / Command / Browser clone / Activity), and `PinPanel` still
   renders whenever `tab === "control"` (line ~1327), regardless of
   `fullScreen`. The owner's new, more restrictive requirement: in
   `fullScreen` mode, render **only** the Session/Power/Security/Diagnostics
   toolbar line + the mesh iframe — no tab strip, no other tabs reachable, no
   `PinPanel` (PIN collect already lives in the **Security** toolbox menu per
   BUG-B's table above — it does not need a second surface). Non-fullscreen
   embedded view is unaffected; this is additive to BUG-A, not a revert of it.

4. **NEW-3 — a REAL bug, not a cosmetic one: switching tabs away from Remote
   control and back BURNS the MeshCentral session.** Traced in
   `components/device-console.tsx`: the tab body is
   `{tab === "control" && (<ControlTab .../>)}` — a plain conditional render,
   so navigating to Summary **fully unmounts** `ControlTab` (and its iframe),
   and returning to Remote control **remounts it fresh** with the SAME
   `mesh.control` URL still held in the parent's `mesh` state. That URL's
   `login=` query parameter is a MeshCentral **one-time login token** — it
   was already consumed by the FIRST mount. The remount's iframe therefore
   tries to authenticate with an already-spent token and MeshCentral
   correctly refuses it ("Unable to perform authentication"). This is the
   same mechanism as TASK_119A's V10/mesh-auth work (see
   `PIPELINE_CONSOLE_BROWSER_CLONE.md`'s recent history), not a repeat of it
   — a spent-token replay, not a cross-site cookie problem. **Fix:** stop
   unmounting the live session on tab switch. Keep `ControlTab` (or at least
   its iframe) mounted once a session is connected, and hide it with CSS
   (`hidden` / `display: none`) rather than a conditional `&&` that tears
   down the DOM node, the same pattern already used elsewhere in this file
   for tab-persistent state. A tab switch must never cost the user their live
   remote session.

**Acceptance (amendment):**
- Fullscreen route: mesh iframe visibly fills the window height (verify at
  two different window sizes — resizing the window changes the iframe's
  rendered height).
- Fullscreen route: only the toolbar line + iframe render — no tab strip,
  no PinPanel, no other tab content reachable.
- Embedded (non-fullscreen) dashboard view: unchanged — tab strip, other
  tabs, and PinPanel under Remote control all still present there (NEW-2 is
  fullscreen-only).
- Live session survives a Remote control → Summary → Remote control round
  trip with NO reconnect prompt and NO new mesh-urls fetch (verify via the
  Network tab: switching tabs must not fire a second `GET
  /api/devices/[id]/mesh-urls`).

---

## Non-goals
- Browser Clone UI slot (TASK_97 owns it; the toolbox reserves *Session* for it).
- Overlay shell-popup behaviour (**TASK_104**, scheduled before this task).
- Telegram approval wiring (**TASK_94**).

## Acceptance (task-level)
- Both bugs fixed as specified; Ping + Reboot + Hide/Reveal live and manual-direct.
- `npx tsc --noEmit` clean; `npm run build` clean; no regression in the console.
- Deployed per `HOW_WE_MOVE_FAST.md` §2 with `--exclude='.env'`; live-verified:
  curl both new routes, then have the owner click ⤢ and each toolbox menu.

## Triage note — "the screen works, but Ping says the agent is unreachable" (2026-09-25)

Reported with a screenshot: the viewer showed a live desktop while the chip read
"Agent not reachable · last check-in 1 min ago", and Hide/Reveal refused with
"device offline". **Not a bug, and not a regression.** The two travel *different
transports*, backed by **two different agents** installed on the device:

| What the user sees | Transport | Backed by | Where |
|---|---|---|---|
| Remote-control viewer (the screen) | MeshCentral URLs | **Mesh Agent** | `lib/device-tools.ts` `fetchMeshUrls` → Vantra `/mesh-urls`; console fetches `mesh-urls` |
| **Ping**, Run now, Hide/Reveal | Vantra `/action` → TRMM *blocking* `/agents/<id>/cmd/` | **TacticalRMM Agent Service** | `pingDevice` → `runCommandNow`; route returns 502 `agentReachable:false` |

So a device whose TRMM agent is slow to check in reports
`{"error":"This device is currently offline."}` (the shape documented at
`lib/device-tools.ts` `normalizeVantraError`), `runCommandNow` throws, Ping answers
502 and Hide/Reveal refuse "device offline" — while an **already-established Mesh
viewer stream keeps running**, because it is a persistent session rather than a
per-command round trip.

Ping is a *blocking* call with `timeoutSeconds: 15`, so a starved or slow host
fails it first and then passes on retry. That matches what the owner observed (the
VM was slow; it worked on a second attempt).

Ground truth from that device: **`Mesh Agent` = Running _and_ `TacticalRMM Agent
Service` = Running** — two services, consistent with the split above.

**Outcome:** no code change. Worth remembering before re-opening this: "viewer up
but agent unreachable" is a normal, expected combination. The chip already shows
the useful signal (check-in age).

