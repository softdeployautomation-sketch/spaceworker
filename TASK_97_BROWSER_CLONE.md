# Task 97 — Browser Clone (P2) — hosted-PC act-as-you + Michael MT-1 contract

**Status: ready to PLAN, gated: build only after Task 93/94/95/96 (Michael's
sequencing: human control + device control exist first). Foundation seams come
free from TASK_92.**
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

## Michael MT-1 contract (isolated build → owner integrates)
- **Deliverable**: device-side scripts for **browser profile capture/restore** — Chrome, Edge, Firefox. PowerShell (Windows first); runs headless under the Vantra agent; args: `--browser <name> --mode capture|restore --out <path> [--profile <name>]`.
- **Rules**: exit codes 0/1/2 (success/partial/fail); NO plaintext secrets, cookies, or passwords in stdout/logs (paths + counts only); handles locked-profile retry; capture output = encrypted archive (DPAPI on source, AES-256-GCM key provided by the SpaceWorker job env — key never written to disk).
- **Repo**: push to `michael-fork` remote (`github.com/Mikeolab/spaceworker`) branch `michael/browser-clone-scripts`, folder `michael/browser-clone/` + README per `MICHAEL_BRIEF.md` template. Owner merges + wraps into the CloneJob pipeline (this task).

## Acceptance
- VM test: clone Chrome profile from work-PC VM → hosted VM → open webmail session → draft reply → approve via Telegram → sent; relay-down test fails closed with clear audit; panic switch kills active clone instantly; `tsc --noEmit` clean; §2 deploy live-verified.
