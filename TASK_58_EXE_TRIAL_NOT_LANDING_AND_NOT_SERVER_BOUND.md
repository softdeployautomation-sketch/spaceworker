# Task 58 — EXE trial not showing in admin, and not actually server-bound (resettable)

**Status: ready to build. Owner-requested 2026-09-21**, found live: "i just loaded the spaceworker, and it should have shown in the admin under active trials... can you investigate why i cant see it, and if the trial license is actually binding, so anonymous users dont just use it on notice."

Two separate questions, two separate findings.

## Part A — why didn't this specific trial show in admin

Server-side pipe is sound (Cline's own synthetic ping landed a row; the admin query in `app/api/admin/exe-trials/route.ts` filters/joins correctly; `HOSTED_APP_URL` is hardcoded correctly in `lib/exe-runtime.ts`; the product id resolves fine). The gap is between the real installed EXE and the server.

**Strongest lead — check this first, it's fast**: `trial-ping` (`app/api/exe-license/status/route.ts`'s `pingTrialStatus`, and `app/api/exe-license/trial-ping/route.ts`) was only added TODAY, commit `7f540d1` (2026-09-20 15:27 +0100 = 14:27 UTC). `gh run list -R softdeployautomation-sketch/spaceworker --workflow="Build EXE"` shows builds at 11:44, 12:08, 12:17, 13:08, and 21:49 UTC on 2026-09-20 — everything **before** 14:27 UTC does not contain the trial-ping feature at all; only the 21:49 UTC build (`e4c1ff9`) does. If the EXE the owner just tested was installed from any of the earlier same-day builds, it simply has no trial-ping code to run — no bug to chase, just a stale install.

1. Confirm which build is actually installed on the machine that was just tested (ask the owner, or check the installer's build timestamp/version if the app surfaces one).
2. If it predates `7f540d1`: trigger a fresh `gh workflow run "Build EXE"`, reinstall per `HOW_WE_MOVE_FAST.md` §5, and retest. This alone may fully resolve Part A.
3. If the installed build IS current and it *still* doesn't land: the fire-and-forget ping in `pingTrialStatus()` swallows every error silently (`.catch(() => {})`, line ~39) — there is currently no way to know if the real EXE's outbound HTTPS to `https://spaceworker.instaweb.top` succeeded, timed out, or hit a DNS/firewall issue on that specific Windows machine. Add a temporary non-silent path (e.g. write the fetch's resolved status/error to the EXE's own local log file, not just swallow it) to actually observe what happens on a real retest, rather than guessing further.

## Part B — the trial is not actually server-enforced (confirmed real gap, not just a maybe)

`lib/license-state.ts`'s `startTrialIfNeeded()`/`trialActive()`/`trialHoursLeft()` read and write **only** a local JSON file (`%APPDATA%\SpaceWorkerOS\exe-license-state.json` on Windows). The file's own top-of-file comment already says the quiet part: *"a determined user can edit the file and reset the timer, an accepted, known limitation of client-side-only licensing... not something to over-engineer around."* Concretely: delete that one file → fresh 24h trial, indefinitely, on the same machine, no email, no account.

This is a bigger gap than it needs to be, because the infrastructure to close most of it **already exists and is unused**:
- `lib/machine-id.ts`'s `getMachineId()` derives a genuinely stable hardware fingerprint (Windows: BIOS/system UUID + disk serial; macOS: `IOPlatformUUID`; Linux: `/etc/machine-id`) — it **survives reinstalls and deleting the local state file**, only falling back to a weaker hostname/MAC hash on VMs/sandboxes with no stable ID.
- `ExeTrialSession` (written by `app/api/exe-license/trial-ping/route.ts`) already upserts on `(machineId, product)` and **never updates `startedAt` on repeat pings** — the server already has the true, tamper-resistant "this hardware's trial actually started at X" the moment a device has ever pinged once.

The gap is purely that the client-side gate **never reads this back**. The ping is currently write-only (fire-and-forget, for admin visibility only) — `status/route.ts` makes its `inTrial`/`trialHoursLeft` decision entirely from the local file, never consulting what the server already knows about this machineId.

**Fix**: in `app/api/exe-license/status/route.ts`, before falling back to the local-only trial decision, **await** (short timeout, e.g. 4-5s — this is now on the gate's critical path, unlike the existing fire-and-forget ping) a call to the server asking "what's the earliest recorded `startedAt` for this `(machineId, product)`, if any" — either add a small new endpoint (e.g. `GET /api/exe-license/trial-status?machineId=&product=`, session-less like `trial-ping`, same rate-limit bucket) or reuse `trial-ping` itself changed to a request/response shape that returns the authoritative `startedAt` in its response body instead of just `{ok:true}`. Then:
- If the server has a record: use `min(local startedAt ?? now, server startedAt)` as the effective trial start — i.e. the EARLIER of the two wins, so deleting the local file can't move the clock forward, only backward (which is already harmless — a device that genuinely never started a trial locally yet but the server has a record for its hardware ID should inherit the server's start time too, closing the "reinstall + delete file" loophole).
- If the server is unreachable (genuinely offline first run): fall back to local-only exactly as today — this is an accepted, smaller residual gap (a persistently-offline machine can still reset locally), not something to solve in this pass.
- Keep writing the server-confirmed `startedAt` back into the local file so subsequent checks are fast/offline-tolerant again until the next reconcile.

**Verification expected**: on a disposable test machine/VM, start a trial, note the machineId (`getMachineId()`'s output, loggable via a disposable script per `HOW_WE_MOVE_FAST.md` §4), delete the local `exe-license-state.json`, relaunch, and confirm the trial gate reports time remaining consistent with the ORIGINAL start (not a fresh 24h) as long as the server is reachable. Also confirm a genuinely first-time machine (no prior server record) still gets a normal fresh trial with no false "already used" block. Confirm the existing 24h window and admin "Active trials" subtab both still work unchanged.
