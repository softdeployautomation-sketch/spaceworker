# Task 108 (bit B2) — Clone agent transport (Vantra side)

**Status: NOT STARTED.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B2**). Depends on **B1** (`TASK_107`).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2 + Michael's integration directive.

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-108-clone-transport`, push.
> **Do not** deploy, ssh the VPS, touch `.env`, or run `prisma migrate deploy`.
> Full rules: `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`HOW_WE_MOVE_FAST.md`** §0–§3, **§6**.
- **`TASK_97_BROWSER_CLONE.md`** §"PR integration (MT-1)" — what is already merged
  and what its scripts/engine actually do, including the F1/F2 fixes.
- **`michael/browser-clone/`** (in this repo): `Invoke-BrowserClone.ps1`,
  `lib/ProfilePaths.ps1`, `lib/CdpCookies.ps1`, `lib/GcmCrypto.ps1`, and `engine/`
  (CLI verbs in `cmd/hack-browser-clone`: `detect · clone · send/package · receive ·
  inject · launch · status · status-all · revoke · expire · audit · preflight ·
  provision-key`; plus `cmd/relay` and `engine/scripts/install-relay.ps1`,
  `install-hosted.ps1`, `set-acls.ps1`).
- **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** §1 — the egress/relay enforcement facts
  (`[IP CHECK 2]` aborts launch without the relay; `[IP CHECK 4]` watchdog kills the
  browser if the relay drops >30 s; `launch --proxy-optional` = the labeled direct path).
- **Vantra patterns to copy exactly:** `app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts`,
  `action/route.ts`, `maintenance/route.ts`, `queued-commands/route.ts`;
  `lib/sw-agent-tenant.ts` (`assertAgentInSwOrg`), `lib/sw-internal-auth.ts`,
  `lib/trmm.ts` (`sendRawCmd`, `getMeshCentralUrls`).

## Michael's directive this task must satisfy

> *Don't build Browser Clone now, but don't architect Task 89 in a way that makes it a
> bolt-on.* The clone is a **device capability**: it reuses **one** approval rail
> (`AgentPendingAction`), **one** audit trail (`AgentActionAudit`), **one** device
> identity (`Device`), **one** transport abstraction, and the **global** panic switch.

Therefore: the SpaceWorker layer must speak **`DeviceJob` / `DeviceAction` /
`DeviceCapability` / `DeviceAudit`** — never a TRMM or MeshCentral endpoint directly.
All TRMM/Mesh specifics stay encapsulated **inside these Vantra routes**.

## Hard requirements

1. **Every route** follows the sibling shape: `verifySwSecret` → **401**;
   `assertAgentInSwOrg(agentId)` → **404** when the agent isn't in a `sw-` org (404,
   never 403 — do not confirm existence to a prober).
2. **MT-1 capture MUST run in the user's interactive session** via
   `sendRawCmd({ runAsUser: true })`. Chrome unwraps the app-bound (`v20`) cookie key
   through its elevation service, which is unreachable from a service/SSH context —
   running capture non-interactively silently yields **zero cookies**. This is a
   recorded finding (`HOW_WE_MOVE_FAST.md` §6); do not "optimize" it away.
3. **Exit-code contract** from the scripts: `0` success, `1` partial, `2` fail.
   A **partial** capture must never be reported as success (the F2 fix).
4. **No secrets in logs.** Paths and counts only — never cookie values, keys, tokens.
   The job key is passed via env by the job, **never written to disk** by the caller.

## Deliverables

New internal routes under `vantra/app/api/internal/sw/devices/[agentId]/`:

| Route | Side | Wraps |
|---|---|---|
| `clone/capture/route.ts` (POST) | **source** | MT-1 capture (`--browser chrome\|edge\|firefox --mode capture --out <path>`), interactive session, encrypted archive out |
| `clone/receive/route.ts` (POST) | **destination** | engine `receive` → `inject` (validate profile) → optional `launch` |
| `clone/launch/route.ts` (POST) | destination | engine `launch` with the job's **egress mode**: `relay` fails closed when the relay is down; `direct` uses the labeled `--proxy-optional` path only |
| `clone/status/route.ts` (GET) | either | engine `status` / `status-all` for the job |
| `clone/revoke/route.ts` (POST) | either | engine `revoke`, and return the staging path so the caller can delete it |
| `relay/install/route.ts` (POST) | source | `engine/scripts/install-relay.ps1` (quarantine-first) |
| `relay/health/route.ts` (GET) | source | probe the relay → `{ status, lastCheckAt, consecutiveFailures }` |

Plus:

- A **transport helper** (e.g. `lib/clone-transport.ts`) that registers/updates
  `DeviceCapability` (`clone-capture`, `clone-host`, `relay`) and creates the
  `DeviceJob` / `DeviceAction` rows under a **stable job id**, so `TASK_109` drives
  jobs by id and never shells out itself.
- Every call writes an `AgentActionAudit` row (`action: "browser-clone"`) carrying
  `sourceDeviceId`, `destinationDeviceId`, `cloneId`, **the egress mode actually
  used** (relay vs direct) and the script exit code.

## Out of scope

- Any orchestration/state machine (`TASK_109`), any SpaceWorker route or UI
  (`TASK_110` / `TASK_111`), the expiry cron (`TASK_112`).
- Re-implementing the engine or MT-1 scripts — **wrap** what is merged.

## Acceptance (owner runs after deploy)

- `tsc --noEmit` clean.
- Every new route: unauthenticated → **401**; non-`sw-` agent → **404**; malformed
  body → **400** (never 500).
- Capture on a live VM produces an archive whose decrypted contents show a
  **non-zero cookie count** (the F1 regression guard), and a locked/sessionless
  profile reports **partial (exit 1)**, not success.
- Launch in relay mode with the relay stopped → **fails closed**, with an audit row
  naming the egress mode; the `--proxy-optional` path succeeds and is audited as
  `direct`.
- Revoke tears the session down, returns the staging path, and the browser process
  is gone (`tasklist` check).
- No TRMM/Mesh endpoint string appears anywhere in the **SpaceWorker** repo diff for
  this pipeline.

## Report back

Files added · `tsc` result · exact route paths + verbs · which engine CLI verb each
route wraps · anything you could not verify without a device.

