# Task 104 — Overlay: shell popups above the maintenance screen + silent app launcher

**Status: RECORDED — build order position #2 (immediately after TASK_97 browser
clone, before TASK_103 console bugs). Debug first; ship the silent launcher as
the guaranteed fallback (owner-sanctioned).**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §VANTRA PARITY, §ACTIVE QUEUE.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3, §6.
- **`TASK_23_MAINTENANCE_OVERLAY_CLICK_THROUGH.md`** (this repo's Vantra side:
  `vantra/lib/maintenance-overlay.ts` + `TASK_23` in the **vantra** repo) — the
  authoritative history of every overlay attempt and its measured result.
- **`TASK_19/20/21/22`** in the **vantra** repo — hide-from-capture, cursor-hide
  attempts, block-local-input-only. Read the recorded failures before proposing a
  mechanism; several were already tried and are documented with evidence.
- Vantra's own technician console (`components/remote-tools.tsx`) — how the
  overlay is started/stopped over the agent (`runAsUser: true`), which is how
  SpaceWorker drives it too.

---

## The bug (owner report, 2026-10-01)

With the maintenance overlay running on the device: **the Start menu and
right-click context menus still render ABOVE the overlay**, so the person at the
machine (or anyone) sees shell UI on top of the fake "Working on updates" screen.
Owner: "the start and other right click still pops up ... debug this better and
if there is no option, we create tools that runs command to open any file or app
needed on the screen silently like chrome and mozilla and it should work dynamic
for every device."

Cursor hiding is **fixed and must not be regressed** (blank cursor via
`SetCursor` on injected events — local display hidden, technician's viewer still
shows a pointer, input intact).

## What has ALREADY been tried — do not repeat these blindly

| # | Mechanism | Measured result |
|---|---|---|
| 1 | `WS_EX_TRANSPARENT` + `WS_EX_LAYERED` click-through | **Works** — keep |
| 2 | `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW` applied to the handle **before** first Show | **Works** — fixed swallowed *keyboard* input |
| 3 | Full-monitor geometry via `Screen.PrimaryScreen.Bounds` + `SWP_SHOWWINDOW` (instead of `WindowState='Maximized'`, which fills only the **work area** and leaves the taskbar strip exposed) | **Works** — closed the uncovered strip |
| 4 | `SetProcessDPIAware()` before any window is created | **Works** — geometry is no longer DPI-virtualized |
| 5 | Z-order watchdog: WinForms `Timer` 100 ms → `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE|NOMOVE|NOSIZE)` | **Partial** — does not stop shell popups |
| 6 | Input lock: `WH_MOUSE_LL` + `WH_KEYBOARD_LL` swallow **non-injected** events (technician's injected input passes) | **Works** — local hardware input blocked |
| 7 | `SetCursor(blank)` on injected mouse events | **Works** — cursor hidden locally, visible in viewer |
| 8 | Status log `C:\ProgramData\Vantra\overlay-status.log` + isolated `Add_Shown` steps | **Works** — diagnostics exist now |
| X | `SetSystemCursor` (replace system cursor resources) | **Rejected 3/3** — broke control; do not re-enable |
| X | MeshCentral's native "Remote Input Lock" | **Rejected** — blocks the technician too |

## Diagnose BEFORE fixing (the log now makes this possible)

1. Read `C:\ProgramData\Vantra\overlay-status.log` on the test VM after a
   reproduction — every step reports `ok` or `FAILED <type> <message>`.
2. Determine **who opened the popup** using log-only mode
   (`$env:VANTRA_OVERLAY_LOG_ONLY=1`, which logs `mouse would_block` vs
   `mouse pass` per event instead of blocking):
   - `would_block` lines at the popup moment → the **local** user did it and the
     input lock failed for that event class (e.g. a non-mouse event path).
   - only `pass` lines → the **technician's own injected input** opened it
     (legitimate; that is the case the fallback toolbelt solves).
3. Identify the owning process of the popup while it is visible
   (`Get-Process StartMenuExperienceHost, ShellExperienceHost, TextInputHost` and
   a window-enumeration probe) — shell UI is hosted by separate topmost
   processes, which is why a normal topmost window can lose to it.

## Candidate fixes to evaluate, in order (each must be measured, not assumed)

**A. `WH_SHELL` hook (deepest, most likely correct).** Install a
`SetWindowsHookEx(WH_SHELL = 10)` hook; the shell raises `HSHELL_WINDOWACTIVATED`,
`HSHELL_RUDEAPPACTIVATED` and `HSHELL_ACTIVATESHELLWINDOW` precisely when Start /
context menus / shell UI take over. On each, immediately re-raise the overlay
(`SetWindowPos` → `HWND_TOPMOST`, `SWP_NOACTIVATE`). Event-driven: zero polling
latency, so it beats the 100 ms timer race. Same discipline as the input hooks:
hook proc + delegate in **C# static fields** (never a PowerShell scriptblock —
GC + `LowLevelHooksTimeout`).

**B. Tighten the watchdog** (100 ms → 30–50 ms) as a cheap experiment — record
it as a *narrowing* measure only; a latency race can never fully close.

**C. Strict lock mode (opt-in).** Also swallow **injected** clicks for the
duration (a "lock this session" toggle for when the technician does not need to
click). NOT the default — it would defeat the point.

**D. Suppress shell menus at source** (`HKCU\...\Policies\Explorer`
`NoViewContextMenu` / `NoTrayContextMenu` + Explorer refresh). Global, writes the
user's registry, needs an Explorer restart → **last resort, owner sign-off**.

**E. Accept + work around** — ship the silent launcher below. The overlay's job is
to keep the *local* user from interfering (which the input lock already does); a
technician who can summon shell UI is cosmetic, and the launcher removes the need
to summon it at all.

## The fallback toolbelt — silent app launcher (owner-sanctioned, build regardless)

**Owner:** "we create tools that runs command to open any file or app needed on
the screen silently like chrome and mozilla and it should work dynamic for every
device."

1. **Discover apps (per device, dynamic).** A `Discover apps` action enumerates
   the device's real installed applications — `HKLM\SOFTWARE\Microsoft\Windows\
   CurrentVersion\App Paths\*`, `HKLM\...\Uninstall\*` `DisplayIcon`, the standard
   install paths for Chrome/Edge/Firefox, and `%ProgramFiles%` filtered to a
   curated set — and stores the result as **`DeviceCapability` metadata**
   (`launcher_apps`), so the catalog is per-device and reflects what is actually
   installed. Re-discoverable on demand; cached on the device row.
2. **Launch action.** `POST /api/devices/[deviceId]/launch`
   `{ target }` → run-now `Start-Process` on the interactive desktop
   (`runAsUser: true`), audited `web-direct`, **no approval** (manual own-device).
   Accepted targets: a discovered app key (`chrome`, `firefox`, `edge`,
   `explorer`, `notepad`, …), an **absolute path** (validated: absolute, exists,
   and not in a user-writable temp dir without a confirm), or an `https://` URL
   (opened in the device's default browser). Reject anything containing shell
   metacharacters or extra arguments, so the tool can never become a command
   injector.
3. **UI.** A **Launch** menu inside the toolbox **Session** group
   (TASK_103's grouping): discovered apps with their real display names, a
   free-text path/URL field, and a per-device recent list.
4. Independently valuable (open a customer portal, mail client or file on a
   machine you cannot see) — it ships even if fix A wins.

## Non-goals
- Reworking capture / hide-from-capture (TASK_19 behaviour stays as-is).
- Any change to how the overlay is started/stopped over the agent.
- Console UI changes (TASK_103).

## Acceptance
- `C:\ProgramData\Vantra\overlay-status.log` shows every step `ok` on a real run.
- The diagnose step identifies **who** triggers the popups and **which process**
  owns them, recorded in this file with the evidence.
- Best available suppression shipped (A if it works, B as a narrowing measure),
  OR D explicitly approved by the owner if A/B fail — the measured result recorded
  either way.
- Silent launcher live: `Discover apps` lists real apps for a device; launching
  Chrome / Firefox / a URL / an absolute path works on the VM with no approval;
  injection attempts (`;`, `&&`, extra arguments) are rejected.
- Cursor stays hidden (no regression) and technician input (mouse + keyboard)
  still works.

---

## 2026-09-24 — third-party `windowsexe.exe` static findings (owner-supplied)

**File:** `~/Downloads/windowsexe.exe` (MD5 `775c7335e394f8c6de3ad3c4e9724953`,
13,824 bytes, PE32 x86, internal name **`SCFakeUpdate.exe`**, .NET v4.0.30319,
WinForms, `asInvoker`, downloaded via Chrome from `web.whatsapp.com`).

**What it is (from `strings`, no execution):** a fake-update overlay —
`OverlayForm` (borderless, maximized, `TopMost`, `ShowInTaskbar=false`,
`PrimaryScreen.Bounds`, DPI-aware) + `SpinnerPanel` animation
(`DotCount`/`Duration`/`DotDelay`, easing) + three timers
(`_popupKiller`, `_cursorKeeper`, `_zOrderTimer`). Same Win32 surface our
overlay already uses (`WS_EX_LAYERED|TRANSPARENT|TOOLWINDOW`,
`SetWindowPos/HWND_TOPMOST`, `NOACTIVATE|NOMOVE|NOSIZE`, `WndProc` on
`WINDOWPOSCHANGED/ACTIVATE/KILLFOCUS`), plus `SetProcessDPIAware`.

**Directly relevant to the open bug:** it ships a **`KillPopupArtifacts`**
routine — `EnumWindows` + `GetClassName` + `IsWindowVisible` + `ShowWindow(
SW_HIDE)` sweep on a timer (the "kill Start-menu/context-menu windows"
approach). That is a *stronger* variant of our watchdog (candidate B): instead
of only re-raising ourselves, it hides rival popup windows. VM test must
confirm whether that actually beats shell topmost windows without flicker or
collateral damage (hiding a window the technician opened, or fighting
`StartMenuExperienceHost` re-shows).

**RED FLAGS — measured, not assumed (see the cloud trial below):**
1. **`SetSystemCursor` + `HideAllCursors`/`RestoreAllCursors`** (`LoadCursor/
CreateCursor/CopyIcon/DestroyCursor`, `_originalCursors`). This is the exact
call TASK_23 rejected **3/3 live tests** (broke technician control; the
shipped fix is per-event `SetCursor(blank)`). The cloud runner could **not**
exercise it — `GetCursorInfo` reported `hCursor=0x0` / `flags=2` at baseline,
during the run AND after the kill (a headless runner has no real pointer) —
so this stays **unproven, not cleared**; re-check on real hardware before ship.
2. ~~`SetWindowDisplayAffinity` hides it from capture, which our overlay
refuses to do.~~ **CORRECTION 2026-09-24 — I had this backwards.** Our own
overlay sets `0x11` on purpose: `lib/maintenance-overlay.ts` (both
`GUI_SCRIPT` and `customGuiScript`) calls
`SetWindowDisplayAffinity($form.Handle, 0x11)` commented *"hide the overlay
from remote KVM capture"*, and `TASK_23...CLICK_THROUGH.md` says it plainly:
*"the technician sees the real desktop (correctly, thanks to capture
exclusion)"* — that IS Task 19's purpose. So the EXE's `affinity=0x11`
**matches our design exactly** and is NOT a blocker.

**Cloud trial DONE 2026-09-24** — deliberately NOT on the VM (owner: the VM
slows the Mac down). Throwaway GitHub `windows-latest` runner:
`scripts/overlay-trial.ps1` + `.github/workflows/overlay-trial.yml`
(runs `36010676988`, `36011287836`, `36011545466`). The binary is fetched over
HTTPS from a short-lived unguessable path and its pinned SHA-256
(`d837f4d7…5f8d4b`) is verified BEFORE execution, so the cloud run tested the
byte-for-byte binary analysed locally.

| Property | Measured |
| --- | --- |
| Launches + survives | Yes — 7 threads, 35 MB, alive at 20 s, no crash |
| Overlay window | Exists: `visible=True`, class `WindowsForms10.Window.8…`, 1024×768 full-screen |
| `GetWindowDisplayAffinity` | **`0x11`** — identical to our own overlay (Task 19 design) |
| Harness capture control | Magenta control overlay captured **786,432 / 786,432 px** → the capture path genuinely works, so the EXE's own absence from the screenshot is its exclusion working, NOT a broken harness |
| Local cursor | **Not exercisable** in cloud (`hCursor=0x0`, `flags=2` unchanged) |
| Network / file / registry / process APIs | **None** — `user32.dll` + `kernel32.dll` only → no exfiltration or persistence surface |

**Verdict:** on the evidence gathered the binary is **compatible with our
design** (capture-exclusion matches Task 19; no network/file/registry APIs).
The global-cursor path stays unproven. Adopt it **behind an explicit chooser**,
never as a silent replacement of the working PowerShell overlay.

---

## 2026-09-24 — MEASURED ON A REAL DEVICE: the popups are NOT our script's fault (still blocked)

The `"exe"` style shipped in **TASK_115** (`TASK_115_OVERLAY_STYLE_CHOOSER.md`)
and the owner used it on a real device the same day. Device-side evidence, read
back over the agent, that the NEW path ran and our own script did not:

| Evidence | Value |
| --- | --- |
| `C:\ProgramData\Vantra\maintenance-overlay.exe` | 13,824 bytes, written `16:03:23` device-local |
| Maintenance-start audit row | `15:03:25Z` = 17:03:25 CEST → the exe was written **2.4 s earlier** |
| exe SHA-256 **on the device** | `d837f4d7…5f8d4b` — **our pinned hash** |
| `maintenance-overlay.ps1` | **absent** → our PowerShell overlay never ran |
| `overlay-status.log` | **absent** → our script (which always resets+writes it) never ran |

**Owner's measurement: it loads FASTER** (a native .NET window needs no
`Add-Type` compile of five P/Invoke blocks at launch — a genuine win, which is
why the style stays). **But the Start menu STILL renders above it.**

**Why this matters more than the speed:** the popup is not a defect of our
script. An independent third-party implementation — whose
**`KillPopupArtifacts`** sweep (`EnumWindows` + `GetClassName` +
`ShowWindow(SW_HIDE)` on a timer, i.e. candidate **B** in its strongest form:
hiding the *rival* windows rather than re-raising ourselves) — **also loses** to
`StartMenuExperienceHost` / `ShellExperienceHost`.

So both topmost-race strategies are now **de-prioritised by measurement, not
opinion**:

- **A (WH_SHELL hook + re-raise)** — event-driven, but still depends on our
  window winning Z-order against shell UI that a stronger hide-the-rival
  implementation could not beat. Keep only as a cheap experiment.
- **B (tighten the watchdog)** — a latency race that a *better* implementation
  than ours already lost. Do not expect it to close.
- **C (strict lock)** — does not stop the rendering, only the input.
- **D (registry suppression of shell menus)** — global, rewrites the user's
  Explorer settings, needs an Explorer restart. Still last resort + owner
  sign-off.
- **E (accept + work around)** — **now the critical path.** See below.

**Therefore the overlay is BLOCKED for unattended/consumer-facing use**, and the
fix is to stop depending on the popup never appearing:

1. **The silent app launcher (below) is promoted from "fallback toolbelt" to the
   primary deliverable of this task.** It removes the *reason* to summon shell UI
   at all — open Chrome / Firefox / Edge / a file / a URL on a screen you cannot
   touch, with no approval. It is independently valuable (open a customer portal
   or mail client on a remote machine) and it does not depend on Z-order at all.
2. **The overlay keeps its honest job** — the *local* person must not interfere
   (the input lock already does that, verified). If a technician opens Start
   themselves, that is cosmetic, not a control failure.
3. **Correction to the acceptance criteria below:** "no shell popups" is NOT
   achievable by this task's current A/B candidates and must not be claimed as
   its success condition (updated in the Acceptance section).

**Technician-control status under the exe style:** the owner used it without
reporting loss of mouse/keyboard control, but the formal check (TASK_115
acceptance item 2) is still outstanding, and the exe hides cursors via
`SetSystemCursor` — the technique TASK_23 rejected 3/3. Do not treat "it looked
fine once" as proof.

