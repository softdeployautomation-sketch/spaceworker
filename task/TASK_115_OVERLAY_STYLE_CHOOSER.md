# Task 115 — Overlay style chooser: two built-in looks + upload your own image

**Repos:** `vantra` (device-side overlay) + `spaceworker` (console UI + route).
**Written:** 2026-09-24.

## Why

Owner, 2026-09-24: *"we should use this new exe for the flow, but we adopt our
png that was rendering … and also add this as an option, so we have two options
to choose for the overlay, and users can also upload to add more."* Resolved
with the owner to: **(1) our existing PowerShell fake-Windows-Update look (the
long-standing default, unchanged) + (2) the owner-supplied fake-update binary,
which renders a smoother spinner — with uploaded images staying an extra.**

## What ships

| # | Piece | Where |
| --- | --- | --- |
| 1 | `OverlayStyle = "update" \| "exe"` on `StartOverlayOpts`; precedence = custom image → `style:"exe"` → default script | `vantra/lib/maintenance-overlay.ts` |
| 2 | `loadMaintenanceExeBase64()` — reads the binary at **runtime** from a gitignored path, verifies a **pinned SHA-256**, caches per process; throws `overlay_style_unavailable` rather than silently falling back | same |
| 3 | `exeLauncherCommand()` — writes the verified bytes into the agent's Vantra dir, starts the EXE detached, records its PID | same |
| 4 | `stopCommand()` also kills a stray `maintenance-overlay.exe` (it is NOT a powershell process, so the old sweep missed it) and still restores cursors unconditionally | same |
| 5 | `style` accepted + forwarded on both Vantra routes (staff + `sw-` internal), `overlay_style_unavailable` → **503 with a plain-English message** | `vantra/app/api/**/maintenance*` |
| 6 | `style` forwarded SpaceWorker → Vantra; custom image validated (allowlist, 2MB cap, magic-byte sniff) with precise errors | `spaceworker/lib/device-tools.ts`, `.../api/devices/[deviceId]/maintenance/route.ts` |
| 7 | Console: **three** Session-menu entries — "Maintenance screen" (default), "Maintenance screen (spinner)" (the exe), "Maintenance with my image…" (PNG/GIF/JPEG picker, client-side size/type check, never stored) | `spaceworker/components/device-console.tsx` |

## The exe must NOT be committed

Both repos are **PUBLIC**, and this is a third-party binary — committing it (or
its base64) would publish it. So the bytes live outside git at
`$MAINTENANCE_OVERLAY_EXE_PATH` (default `assets/maintenance-overlay.exe`, and
`/assets/` is in `vantra/.gitignore`) and are read at runtime, then embedded into
the one-shot launcher command exactly like the custom image already is. The
SHA-256 is pinned, so a swapped file is refused rather than executed.

Placed on the server at `/opt/vantra/assets/maintenance-overlay.exe`
(`chown vantra`, `chmod 644`). Deploys must **never** `--delete` that path.

## Rollback

The default style is our own script and was **not touched**, so rollback is
"don't pick the spinner option" — no code revert needed. Full removal = delete
`/opt/vantra/assets/maintenance-overlay.exe`; the style then answers 503
"not installed on the server" instead of failing obscurely.

## Evidence for this exact binary (cloud trial, 2026-09-24)

Throwaway GitHub `windows-latest` runner — **no VM, no load on the owner's Mac**
(`spaceworker/scripts/overlay-trial.ps1`, runs `36010676988`/`36011287836`/
`36011545466`, SHA-256 `d837f4d7…5f8d4b` verified before execution):

- launches and survives: 7 threads, 35 MB, alive at 20 s, no crash;
- overlay window `visible=True`, class `WindowsForms10.Window.8…`, 1024×768;
- `GetWindowDisplayAffinity` = **`0x11`** — identical to our own overlay, which
  sets it on purpose (Task 19: the technician sees the real desktop);
- harness control proved the capture path works (magenta overlay captured
  786,432/786,432 px), so the exe's absence from the capture is its exclusion
  working, not a broken test;
- imports only `user32.dll`/`kernel32.dll` — no network, file, registry or
  process APIs, so no exfiltration or persistence surface.

## KNOWN DELTA — why this is opt-in, not the new default

The binary does **not** block the local user's real hardware input (no
`SetWindowsHookEx` import), and it hides cursors with `SetSystemCursor` — the
exact technique TASK_23 rejected **3/3 live tests** for breaking technician
control. The cloud runner has no real pointer (`GetCursorInfo` `hCursor=0x0`,
`flags=2` before/during/after), so that path is **unproven, not cleared**.

## Acceptance (live test, real device)

1. Pick **"Maintenance screen"** → fake-Windows-Update look appears on the
   machine; technician keeps full mouse **and keyboard** control.
2. Pick **"Maintenance screen (spinner)"** → the exe's screen appears; re-check
   the same mouse/keyboard control (the TASK_23 failure mode) and the cursor on
   **both** sides.
3. Pick **"Maintenance with my image…"** with a PNG → the image shows full-screen.
4. **Stop overlay** from any of the three → screen clears, cursors restored,
   `maintenance-overlay.exe` gone from the process list.
5. With the asset removed, "spinner" answers *"That overlay style is not
   installed on the server."* — not a generic 502.

Record the measured result for (2) in this file either way.

## "Which style actually ran?" — now answerable (2026-09-24)

Owner: *"the maintenance overlay still shows the start menu in the device screen,
but this one is faster … just confirm if it's the new exe that's in the flow, so
we are sure it's not the same flow."*

**It could not be answered, and that was a defect in this task.** The style is
resolved in `startMaintenanceOverlay` (custom image → `"exe"` → default script)
and the resolved choice was returned to nobody; SpaceWorker then wrote a
`device_maintenance-start` audit row with **`detail: null`**. Two real overlay
starts on device `Sc` (14:59:56Z and 15:03:25Z) therefore cannot be attributed to
either flow after the fact — the exact question being asked.

Fixed (`vantra/e09d3f7` + `spaceworker/afbe661`):

| Piece | Change |
| --- | --- |
| `MaintenanceStyleUsed = "update" \| "exe" \| "custom-image"` | `startMaintenanceOverlay` now **returns** which flow it launched. `custom-image` is its own value — the uploaded image runs through OUR script, so calling it `"update"` would rebuild the same ambiguity |
| Vantra `sw` route | echoes it as `style` in the JSON response |
| SpaceWorker `lib/device-tools.ts` | records `detail: { style, requested }` on the audit row; falls back to the request when Vantra is an older deploy that does not echo, so a mixed-version deploy never writes a guess as fact |

### How to confirm the style yourself, without asking anyone

Device console → **Activity** (or Admin → audit) → the `device_maintenance-start`
row now carries `style`. `"exe"` = the owner-supplied binary; `"update"` = our
PowerShell fake-Windows-Update screen; `"custom-image"` = your uploaded picture.

### Fast vs slow is expected, and is NOT the tell

The exe being visibly faster is consistent with the evidence and does not by
itself prove the new path ran: our PowerShell style pays a one-off `Add-Type`
compile of five P/Invoke blocks at launch (see the TASK_104 finding). Use the
audit row above as the authority, not the speed.

