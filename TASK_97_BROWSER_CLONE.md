# Task 97 — Browser Clone (P2) — hosted-PC act-as-you + Michael MT-1 contract

**Status: NEXT (build order position #1). Michael's MT-1 deliverable has LANDED
as PR #2 (`michael/browser-clone-scripts`, +9,329/−0, open) — review → test →
integrate, then build the CloneJob pipeline on top of it.**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY (P2), §SCHEMA, §CROSS-TRACK RULES.**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92) — note: hosted clone PCs are dedicated devices (start on the personal-VM/lab host), NEVER the production VPS.
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §PRIORITY P2 (full directive), §CROSS-TRACK RULES 1/2/5/6 (singular gate; secrets classes; shared primitives; total panic switch).
- **`browser-server/`** in this repo — the existing headless-Chromium stack to reuse for the hosted runtime.
- Michael's directive in the plan §PRIORITY P2 (topology, relay policy, security boundary).

## Goal
Move a user's browser environment (profiles, sessions, cookies, extensions) from work PC → hosted SpaceWorker PC; agent operates it there; egress stays the user's network identity.

## Deliverables
1. **Migration**: `CloneJob` (userId, sourceDeviceId, destinationDeviceId, relayId, lifecycle, launchState, browserProfileRef) + `RelayHealth` + `HostedBrowserSession`.
2. **Clone flow (all through the ONE gate)**: proposal (kind "browser-clone") → approve (web/Telegram) → CloneJob → source-device agent runs capture (MT-1 scripts) → secure transfer → hosted device agent validates/injects → session active → audit (`AgentActionAudit` with sourceDeviceId/destinationDeviceId/cloneId).
3. **Hosted device provisioning**: hosted PCs register as Devices (Device B in the plan topology); hosted browser runtime = `browser-server` profile per CloneJob; TTL + teardown.
4. **Egress relay enforcement**: relay through the work PC as launch/runtime policy — launch MUST FAIL (never silently fall back) if required relay is down (`RelayHealth` gate).
5. **Panic switch integration**: global kill covers clone jobs + active sessions (extend the Task 92 panic primitive — no isolated revocation path).
6. **UI**: clone section in device detail (start/stop/status); active sessions visible; email-when-off works: (a) IMAP mailboxes via existing plumbing, (b) webmail via hosted clone browser; drafts → gated proposal either way.
7. **Admin limits (CROSS-TRACK RULE 7):** hosted clone PCs are RAM consumers — clone-session concurrency, per-user concurrent clone cap, and hosted-PC pool size are AdminSetting keys in the admin panel (pattern: admission-control's enabled + max + live counts). No hardwired limits.

## Michael MT-1 contract (isolated build → owner integrates)
- **Deliverable**: device-side scripts for **browser profile capture/restore** — Chrome, Edge, Firefox. PowerShell (Windows first); runs headless under the Vantra agent; args: `--browser <name> --mode capture|restore --out <path> [--profile <name>]`.
- **Rules**: exit codes 0/1/2 (success/partial/fail); NO plaintext secrets, cookies, or passwords in stdout/logs (paths + counts only); handles locked-profile retry; capture output = encrypted archive (DPAPI on source, AES-256-GCM key provided by the SpaceWorker job env — key never written to disk).
- **Repo**: push to `michael-fork` remote (`github.com/Mikeolab/spaceworker`) branch `michael/browser-clone-scripts`, folder `michael/browser-clone/` + README per `MICHAEL_BRIEF.md` template. Owner merges + wraps into the CloneJob pipeline (this task).

## Acceptance
- VM test: clone Chrome profile from work-PC VM → hosted VM → open webmail session → draft reply → approve via Telegram → sent; relay-down test fails closed with clear audit; panic switch kills active clone instantly; `tsc --noEmit` clean; §2 deploy live-verified.

---

## PR integration (MT-1) — DO THIS FIRST

**PR:** `https://github.com/softdeployautomation-sketch/spaceworker/pull/2` —
branch `michael/browser-clone-scripts`, +9,329/−0, state OPEN.

Owner rule for this repo: **review the PR locally, test it, integrate it —
and only then build the CloneJob pipeline around it.** Do NOT merge blind, and do
NOT start the pipeline before the scripts are proven on the VM.

Review checklist (in this order):
1. **Read `michael/browser-clone/README.md`** (required by
   `MICHAEL_BRIEF.md`) — expected: what each script does, its args, exit codes
   (0/1/2), and the devices/browsers it was tested against.
2. **Contract check against this task's MT-1 section** — args
   `--browser <name> --mode capture|restore --out <path> [--profile <name>]`,
   encrypted archive output, DPAPI on source, key from job env, **no plaintext
   cookies/passwords/session tokens in stdout or any log** (grep the scripts for
   stdout writes of secrets — this is the one hard security gate).
3. `tsc --noEmit` is not enough here (PowerShell) — do a **static parse on the
   VM** (`[System.Management.Automation.Language.Parser]::ParseFile` → prove
   syntax without executing), same gate we used for the overlay scripts.
4. **Functional test on the VM** — capture a Chrome profile, verify the archive
   is encrypted and the key is not on disk, restore it into a second profile
   directory, launch that profile and confirm a logged-in session (e.g. a webmail
   tab) comes up. Firefox and Edge the same way if the scripts claim support.
5. **Failure-path test** — locked profile (browser running) → retry/exit code 2
   path; missing browser → exit 2; bad key → exit 1. Record what actually happens.
6. Then integrate: scripts ship under `michael/browser-clone/` unchanged (they are
   the device-side artifact the CloneJob will call); the pipeline (deliverables
   1–7 above) is ours.
7. `git push` your integration commit; the PR itself is merged only after the VM
   test passes — note the merge + test result in this file.

**Record results here** (date, VM, browsers tested, pass/fail per script, and any
deviation from the MT-1 contract that we accepted):
- _pending_

