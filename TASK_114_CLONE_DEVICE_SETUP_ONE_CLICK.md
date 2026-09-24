# Task 113 (bit C2-fu) — One-click clone-device setup (engine + relay, no hands on the machine)

**Status: IN PROGRESS — built + committed, deployment/verification running (owner
request 2026-09-24).**
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
