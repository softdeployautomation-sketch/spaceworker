# Task 110 (bit B4) — Clone API routes + gating

**Status: DONE · DEPLOYED · VERIFIED 2026-09-24** (20/20 live harness; 5 routes live).
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B4**). Depends on **B3** (`TASK_109`) + **G1** (`TASK_105`).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2, §CROSS-TRACK RULES 1/7.

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-110-clone-api`, push.
> **Do not** deploy, ssh the VPS, touch `.env`, or run `prisma migrate deploy`.
> Full rules: `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`HOW_WE_MOVE_FAST.md`** §0–§3, **§6** (route-dir rsync trap; never leak raw
  upstream bodies like `<!DOCTYPE html>` into the UI).
- **`TASK_109_CLONE_ORCHESTRATOR.md`** — you add **no** logic that belongs there;
  routes are thin.
- **`TASK_108_CLONE_AGENT_TRANSPORT.md`** — the SpaceWorker repo must never call
  TRMM/Mesh directly.
- **Patterns to copy exactly:** `app/api/devices/[deviceId]/run-command/route.ts`,
  `.../queued-commands/route.ts`, `.../maintenance/route.ts`, `.../actions/route.ts`;
  `lib/session.ts` (`getSession`), `lib/device-tools.ts` (the service-call layer +
  `normalizeVantraError`), `lib/entitlements.ts` (`hasEntitlement`).
- **`TASK_95_DEVICES_V2_TOOLS_PARITY.md`** — the owner-scoping and error-shaping
  conventions these routes must match.

## Deliverables (all session-gated, owner-scoped)

| Route | Verb | Behaviour |
|---|---|---|
| `app/api/devices/[deviceId]/clones/route.ts` | POST | start a clone: `{ egress: "relay" \| "direct", browser: "chrome"\|"edge"\|"firefox", profile?, destinationDeviceId? }` → calls `requestClone()`. Returns **201** created, or **202** when the governor placed it in the queue (with the reason) |
| `app/api/devices/[deviceId]/clones/route.ts` | GET | clone history for that device (newest first) — the UI's history list |
| `app/api/clones/[cloneId]/route.ts` | GET | single clone status/progress (for polling) |
| `app/api/clones/[cloneId]/advance/route.ts` | POST | drive the next step (`advanceClone`) — lets the first run progress without waiting for the sweep; must be safe to call repeatedly |
| `app/api/clones/[cloneId]/revoke/route.ts` | POST | `revokeClone()` |
| `app/api/clones/[cloneId]/route.ts` | DELETE | `deleteClone()` — **terminal states only** |
| `app/api/clones/[cloneId]/session/route.ts` | GET | the hosted-session open URL + display metadata for the full-screen window |

Route rules:

1. **Thin.** Validation, auth, owner-scope, error mapping. All lifecycle logic lives in
   `TASK_109`. Do **not** audit here — the orchestrator already audits every
   transition; double rows make the audit useless.
2. **Gating is server-side.** The UI hiding a button proves nothing:
   direct egress requires the premium entitlement **and**
   `cloneDirectEgressPremiumOnly`; the base capability requires the clone/assistant
   entitlement. Refusals are explicit (**403** with a human reason), never silent.
3. **Owner-scope every read and write** by `session.userId` → a clone belonging to
   another user is **404**, never 403.
4. **Clean errors only.** Shape upstream failures through the existing normaliser so
   the UI never renders a raw upstream body; map "relay unavailable" and "device
   offline" to distinct, actionable messages (the UI copy depends on them).
5. **No secrets in responses.** Session payloads carry the open URL and display
   metadata only — never profile contents, cookie data or job keys.

## Out of scope

- The clone tab/card/session window UI (`TASK_111`).
- The sweep timer (`TASK_112`) — `advance` exists so the pipeline is driveable before it.
- Any change to `TASK_108`'s Vantra routes or `TASK_109`'s state machine.

## Acceptance (owner runs after deploy)

- `tsc --noEmit` clean; local build green.
- Unauthenticated on **every** route → **401**.
- Another user's `cloneId` → **404**; malformed body → **400**; wrong `egress` value → **400**.
- Non-premium user requesting `direct` → **403** with a readable reason; with premium → accepted.
- Governor at capacity → **202** with the queue reason (not a 500, not a silent success).
- Every route returns **JSON** even on failure (no HTML body ever reaches the client).
- No TRMM/Mesh URL string appears in the SpaceWorker diff for this pipeline.

## Deploy record (owner, 2026-09-24)

- Branch `agent/task-110-clone-api` (`75c789d`, 5 files, 568 insertions, no other
  paths touched) fast-forwarded into `main`, pushed.
- Code-only bit: no migration. Rsync `--files-from` + `--exclude='.env'` of the 5
  route files; `md5` matches local; build as `trmm` from `/opt/spaceworker`
  (`Compiled successfully`, all 5 route slots present); service restarted, active,
  landing/login 200, zero new journal errors.
- Live harness (disposable, `.mts` + stub-server-only, deleted after run):
  **20/20 PASS** — bad egress/browser/role/status → 400 JSON; no entitlement →
  403 with zero CloneJob created; unowned device → 404; relay + hosted pool →
  201; cross-user GET/revoke/advance/session → 404 ×4; owner GET 200; history
  lists row; pre-launch session 404; DELETE live → 409 `clone_not_terminal`;
  revoke 200 + idempotent; DELETE terminal 200; `deleted` filtered from history.
  Residue re-checked to zero (CloneJob/User/Device/RelayHealth 0/0/0/0).
- Remaining owner-only: `direct`-without-premium 403 copy, 202 queue copy, real
  device capture/launch (`advance` drives device RPC — not exercised live here).

## Report back

Files added · `tsc` result · the exact route paths + verbs · the status codes you
chose for each gate · anything unverified.
