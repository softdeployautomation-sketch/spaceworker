# Task 113 (bit C2-fu) — One-click clone-device setup (engine + relay, no hands on the machine)

**Status: DONE · MERGED · DEPLOYED · VERIFIED 2026-09-26 — the one-click setup has since run live
(owner request 2026-09-24; closed 2026-09-26).** The server half is proven end-to-end: B8-2 re-ran
`Sc`'s relay **through this route** (not a manual ssh flag) and it came up in genuine dial-out mode,
and the clone then launched against our own Neko destination. **Owner-only: the button click itself
on `Sc`.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **C2-fu** — console follow-up;
unblocks **B4/B5** relay mode, which never had an installer UI).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2.

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-114-device-setup`, push.
> **Do not** deploy, ssh the VPS, touch `.env`, or run `prisma migrate deploy`.
> Full rules: `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Owner's report (2026-09-24) — why this bit exists

> "why cant you install the relay, is it suppose to be in our server, i want
> everything to be automated, clickable input, not user having to go install
> something."

Two findings behind that:

1. **`runRelayInstall()` had ZERO callers.** TASK_108 shipped the transport
   (route + quarantine-first script) and TASK_109/110 gate on a `RelayHealth`
   row, but no route, no button and no way for a device to obtain the binaries —
   so every relay-mode clone died at
   `No egress relay is registered on that device`.
2. **`install-relay.ps1` could not succeed even if run by hand.** It called
   `preflight` on the RELAY binary (`& $NewExe preflight --dir …`), but
   `preflight` only exists in the ENGINE CLI (`cmd/hack-browser-clone`) — the
   relay parses no subcommands, so it exited 2 and the script aborted *before*
   copying anything ("refusing to install"). Fixed here.

## Where the relay actually belongs (the owner's question, answered)

The relay (`hack-relay.exe`, `cmd/relay`) is a **Windows binary that must run on
the customer's device** — it is the CONNECT/HTTP proxy the hosted clone browser
dials (`launch --proxy 127.0.0.1:8118`) so every request egresses from the WORK
PC's public IP and carried sessions stay valid. It **cannot** live on our VPS: a
VPS-hosted relay would give the clone the VPS's IP, which is exactly what relay
mode exists to prevent. So "automated" means: **our server hosts the artifacts,
the agent downloads + verifies + installs them locally.** Nobody visits the
machine, and nothing is installed by hand.

## Deliverables

1. `lib/clone-engine-dist.ts` — artifact manifest + **HMAC-signed, single-device,
   short-lived** download URLs (no public path; the signature is the auth because
   the caller is a SYSTEM-context agent with no cookie; fails closed with no
   secret).
2. `app/api/clone-engine/[file]/route.ts` — `GET` serving one artifact; 403
   without a valid signature, 404 for an unknown name, bytes streamed with
   `Content-Length` + `no-store`.
3. `scripts/engine-dist.mjs` — reproducible bundle build: cross-compiles the
   three Windows binaries and copies the installers + MT-1 capture skin, then
   writes `engine-dist/manifest.json` (SHA-256 + bytes per artifact).
   `engine-dist/` is gitignored (build output) and rsynced at deploy.
4. `lib/clone-setup.ts` — the orchestrator, one call per role:
   1. **fetch** — signed URLs → `Invoke-WebRequest` → `Get-FileHash` verify →
      `Unblock-File` (Mark-of-the-Web would otherwise block execution);
   2. **quarantine + stage** — the **engine CLI** preflights the install folder
      (Defender path + process exclusions verified while it is still empty per
      the documented quarantine rule), then the verified bundle lands in
      `C:\ProgramData\TacticalRMM\CloneTool` and the staging folder is removed;
   3. **role install** — `source`: relay through TASK_108's sanctioned
      `relay/install` route, then a real health probe, then the `relay` +
      `clone-capture` capabilities. `hosted`: the receiver install (silent GUI
      twin as a scheduled task) then `clone-host`.
   Steps are sequential and fail closed; the device's own `STEP:` lines are
   returned so a refusal names the step that failed.
5. `app/api/devices/[deviceId]/clone-setup/route.ts` — `GET` status (relay row +
   capabilities, no device RPC) and `POST { role: "source" | "hosted" }`.
   Manual own-device action, no approval rail (same posture as Ping/Run now).
6. Console — a **Device setup** card in the Browser clone tab: "Set up this PC"
   and "Set up as clone host", each one click, with a per-step result list and
   the relay's address/status/checked-at once it is live.
7. `lib/agent-visibility.ts` — **reveal fix from VM ground truth**: the real
   DisplayName is `TacticalRMM Agent Service` (not `Tactical Agent`), so the
   inverse of Hide now restores the name that actually exists on the box.

## VM ground truth captured (2026-09-24, `ssh myrat@192.168.0.103`)

```
Name        DisplayName                Status
----        -----------                ------
Mesh Agent  Mesh Agent                 Running
tacticalrmm TacticalRMM Agent Service  Running
```

(Apps list before Hide: only `Mesh Agent` appears; the TRMM MSI entry does not
show on this build — so "hide" is proven by the service DisplayName + the
uninstall key's `SystemComponent`, not by an Apps-list row that isn't there.)

## Out of scope

- Pooling/provisioning the hosted clone PCs (which machine is in the pool) —
  this bit makes *any* chosen device installable as a host in one click.
- Capture/launch verification with a real browser profile (still owner-only).
- Any new Vantra route: the relay install reuses TASK_108's, the hosted install
  runs the sanctioned script over the existing run-command transport.


## VM rehearsal (2026-09-24, `ssh myrat@192.168.0.103`, stock Windows + Restricted ExecutionPolicy)

Ran the EXACT chain the app runs, and it found two more real blockers:

1. `hack-browser-clone.exe --version` → `hack-browser-clone 0.1.0` (exit 0) —
   the cross-compiled Windows binaries execute.
2. `preflight --dir …\CloneTool` → `{ "method": "defender-exclusion",
   "verified": true, "ok": true }` — the quarantine rule holds while the folder
   is still empty.
3. `& install-relay.ps1 …` → **REFUSED**: "running scripts is disabled on this
   system" (ExecutionPolicy=Restricted). Inline script text is exempt, which is
   why every inline console tool worked and this file-based path never did.
   Fixed in both places that invoke a `.ps1`: our hosted step and Vantra's
   `buildRelayInstall` / `buildMt1Capture` builders now use
   `powershell -NoProfile -ExecutionPolicy Bypass -File`.
4. With the bypass: `RELAY_EXIT=0`, `TCP 127.0.0.1:8118 LISTENING`,
   `schtasks` → `SpaceworkerRelay … Running`.
5. **Egress proof (the whole point of relay mode):**
   `DIRECT_IP=212.8.243.127` and `RELAY_IP=212.8.243.127`, CONNECT `200` — the
   relayed request leaves from the device's own IP, i.e. carried sessions stay
   valid. (Matches the DESIGN's live VM→hosted claim.)
6. `install-hosted.ps1 -NewExe <install dir>\hack-browser-clone.exe` → FAILS
   ("Cannot overwrite the item … with itself"). Fixed by installing FROM the
   staging dir and cleaning staging up LAST, on success and failure.

**Still owner-only (needs a signed-in click):** the signed-URL fetch step
(`Invoke-WebRequest` + `Get-FileHash` + `Unblock-File` against
`/api/clone-engine/<artifact>?d=…&e=…&s=…`) and the app-side relay install
through Vantra's route. Route boundaries are live-verified: no signature → 403,
unauthenticated setup → 401.

---

## 2026-09-24 (later) — LIVE DEVICE EVIDENCE: source role works, hosted role had a real bug, and the one-device limit

Read straight off the production DB + `AgentActionAudit` (read-only probe, no
device commands issued by me).

### The SOURCE role now genuinely works, on a real device

| Evidence | Value |
| --- | --- |
| Device `Sc` | `status=online`, `lastSeen` 0.6 min old, `vantraAgentId` set |
| Capabilities | `[relay, clone-capture]` → `sourceReady = true` |
| `RelayHealth` | `addr=127.0.0.1:8118`, **`status=up`**, `consecutiveFailures=0` |
| Watchdog | `browser-clone/executed {step:"relay-probe", status:"up"}` every ~5 min |

So the one-click relay install (the owner's original ask — *"why cant you
install the relay … not user having to go install something"*) is **done and
proven**: the artifact is fetched over a signed URL, hash-verified, installed,
and the relay answers its probe from the work PC. The 5-minute `relay-probe`
rows are the intentional health watchdog, **not** an error.

### The HOSTED role failed for a now-fixed reason — and it needs one retry

`15:06:33Z  device_run_now/executed  step hosted-install FAIL:1
powershell.exe : ERROR: No mapping between account names and security IDs was
done.` — that is `schtasks /Create` with no `/RU` running as SYSTEM. Fixed in
**`a32e260`** (resolve the `explorer.exe` owner and `Register-ScheduledTask`
with an Interactive token + declare the inbound firewall rule first). The VPS
already serves the fixed script (`install-hosted.ps1` sha256 `ba0e45df…909b2`,
identical in the manifest and on disk), and the failure **predates** it — so the
owner's next click of **"Set up as clone host"** is the first run of the fix.

### `CloneJob`: ZERO rows — nothing downstream has ever run

The clone job table is empty, i.e. **every Start so far was refused during
validation** and a job was never created. Read that as: capture → transfer →
inject → launch — the entire pipeline — is still **unexercised**. "The relay is
up" must not be restated as "the clone works".

### Two code bugs fixed from this evidence

1. **`a32e260`** — the hosted installer (above).
2. **`a64cfd4`** — `hostedAvailableForUser()` asked *"does the user own ANY
   online clone host?"* **without excluding the device being viewed**, and that
   flag drives the pre-Start warning on the SOURCE card. Setting a device up as
   a clone host therefore made its own card say "fine" — while a clone can never
   use its own source as its destination (`pickHostedCloneDevice` skips it; the
   explicit path refuses `same_device`) — and Start then refused with
   `no_hosted_clone_device`. Now it counts only OTHER online hosts, and the copy
   says to set the host up on a **second** PC.

### THE REMAINING BLOCKER — and a correction (TASK_117, owner 2026-09-24)

A clone needs **two machines**: the work PC (capture + relay) and a hosted PC
(where the copied browser runs). Today the fleet is `Sc` (online, source-ready —
the owner's **test** VM) and `WilkSF9` (a **customer's** PC).

`Device.deviceKind = "hosted"` is only ever **counted**
(`app/api/admin/clone-limits/route.ts`) — nothing in the codebase writes it, so
the pool is permanently 0.

**Two statements that were here are withdrawn as wrong:**

1. *"The one-click button is the only way to obtain a clone host, which is the
   intended design."* — Wrong. `TASK_114`'s "Set up as clone host" button was
   built for **SpaceWorker's own** hosted PCs. It is not a customer task, and
   the product design (`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7, the plan's
   "dedicated hosted devices") never intended a customer machine to host clones
   of other sessions.
2. *"A VPS cannot be the clone host: the engine launches a visible browser and
   needs a real desktop session."* — Wrong, and the engine says so itself:
   `runPreflight` has an explicit branch documented for "**POSIX hosted
   servers**", `pkg/browser/detect.go` resolves browsers from `PATH` first
   ("POSIX dev hosts") before falling back to Windows install paths, and the
   platform-specific files exist for non-Windows builds (`dpapi_other.go`,
   `disk_free_unix.go`, `injector_posix_test.go`). `DESIGN_…` §5 states the
   engine "**already launches headless for validation**" — and the technician
   sees the session through the app's viewer, which is exactly how the existing
   private-browser (`browser-server/` + Neko container) already works.

So the fix is to **provision the pooled hosted PC we always meant to have** —
scoped in `TASK_117_HOSTED_POOL_PROVISIONING.md`. The two `Sc → Wilk` /
`Wilk → Sc` options that were listed here are **withdrawn**: `WilkSF9` is a
customer's machine and must not be used as test or clone infrastructure.
