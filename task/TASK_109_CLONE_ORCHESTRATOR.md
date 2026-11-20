# Task 109 (bit B3) — Clone orchestrator (`lib/clone.ts`)

**Status: DONE · DEPLOYED · VERIFIED 2026-09-24 (main `9e09145`).** `lib/clone.ts`
(state machine, TTL, egress gate, panic leg, read model) + the panic extension in
`lib/devices.ts`. Local gates: `tsc --noEmit` + `eslint` + `npm run build` all clean.
Deployed live (hash-verified rsync, built as `trmm`, restarted) and acceptance-verified
with a disposable live harness — **57/57 assertions PASS** (see "Verification" below).
Still owner-only: real capture/launch against a physical Windows device.
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B3**). Depends on **B1** (`TASK_107`) + **B2** (`TASK_108`).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2, §CROSS-TRACK RULES 1/5/6/7.

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> Implement, `tsc --noEmit` clean, commit on `agent/task-109-clone-orchestrator`, push.
> **Do not** deploy, ssh the VPS, touch `.env`, or run `prisma migrate deploy`.
> Full rules: `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`HOW_WE_MOVE_FAST.md`** §0–§3, **§6**.
- **`TASK_97_BROWSER_CLONE.md`** — deliverables 2/4/5/9 (flow, relay enforcement,
  panic integration, explicit egress policy) and the whole MT-1 contract.
- **`TASK_108_CLONE_AGENT_TRANSPORT.md`** — the routes/`DeviceJob` concepts this
  drives; **you call those, never TRMM/Mesh**.
- **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** — the three launch modes and the
  per-clone record/history fields the UI will read.
- **Existing primitives to reuse (do not fork):** `lib/devices.ts`
  (`recordAgentActionAudit`, `panicStopAllDevices`, `deviceStatus`),
  `lib/vantra-link.ts` (`vantraFetch`), `lib/entitlements.ts` (`hasEntitlement`),
  `lib/clone-settings.ts` (from `TASK_107`), `lib/admin-settings.ts`.
- **`TASK_105_RESOURCE_GOVERNOR_QUEUE.md`** — how a high-RAM feature asks for a slot.

## Goal

One module that owns the clone **lifecycle**: it takes a request, drives the source
device → hosted device sequence through `TASK_108`'s transport, enforces TTL and
egress policy, writes the audit, participates in the panic switch, and hands the UI a
truthful per-clone record (dates, status, egress mode, expiry).

## Canonical lifecycle states (define as a typed union, use everywhere)

```
requested → awaiting_source → capturing → captured → transferring
         → received → injecting → ready → launching → active
terminal: expired_idle | expired_hard | revoked | deleted | failed
```

Rules:
- **Forward-only.** An illegal transition throws; it never silently coerces.
- `failed` records **why** (script exit code 1 = partial, 2 = fail, transport error
  string) — never a bare `failed`.
- **`ready` (injected, validated) is the only state from which `launching` is legal** —
  this is the `[INJECT CHECK 5]` validation gate made structural.
- The **staging path** (`stagingRef`) is only meaningful between `captured` and
  `expired/revoked`; `TASK_112` deletes it at the terminal state.

## Deliverables — `lib/clone.ts` (one module, exported functions only)

| Export | Responsibility |
|---|---|
| `requestClone({ userId, sourceDeviceId, destinationDeviceId?, egress })` | gate + create: entitlement check (`lib/entitlements.ts`), premium-only check for `egress: "direct"`, then create `CloneJob` + its `DeviceJob` in `requested`; ask `TASK_105` for a resource slot |
| `advanceClone(cloneId)` | **the state machine.** Idempotent + crash-safe: read state → call exactly one `TASK_108` route → persist the transition → audit. Safe to re-enter at any time |
| `revokeClone(cloneId, actor)` | `TASK_108` revoke → terminal `revoked` → mark staging deletable; audited |
| `deleteClone(cloneId, userId)` | user-initiated record delete — **terminal states only**, owner-scoped, never deletes an active session |
| `expireClones()` | idle-TTL + hard-TTL enforcement → terminal + revoke (called by `TASK_112`) |
| `getClone(cloneId)` / `listClones(userId, filters)` | the UI read model: date, status, browser/profile, **egress mode**, TTL remaining, relay health, error text |
| `refreshRelayHealth(deviceId)` | probe via `TASK_108`'s relay route and update `RelayHealth` in place |

Hard rules for this module:

- **Governor, not a bypass.** If `TASK_105`'s governor has no slot, the clone waits —
  represent the wait on `DeviceJob.status = "queued"` (an existing concept) rather
  than inventing a new `CloneJob` state; the sweep retries `advanceClone`.
- **Panic integration is an EXTENSION, not a sibling.** Extend
  `lib/devices.ts::panicStopAllDevices` so it also revokes pending/active clone jobs
  and tears down sessions. There must be **no** separate clone kill-switch.
- **Egress is explicit.** `relay` (default) fails closed when the relay is unhealthy
  — a refusal, never a silent downgrade. `direct` is only reachable with the premium
  entitlement **and** `cloneDirectEgressPremiumOnly`. Whichever ran is written to the
  `CloneJob` **and** the audit.
- **No secrets.** `CloneJob` / `DeviceJob` rows carry paths, ids, counts and status
  only — never cookie values, profile plaintext, job keys, or tokens.
- **Audit every transition** through `recordAgentActionAudit` (`action: "browser-clone"`),
  including the terminal one with the reason (idle TTL, hard TTL, revoked, failed+code).

## Out of scope

- Transport/routes (`TASK_108`), SpaceWorker HTTP routes (`TASK_110`),
  UI (`TASK_111`), cron/systemd wiring (`TASK_112`), the governor itself (`TASK_105`).

## Acceptance (owner runs after deploy)

- `tsc --noEmit` clean.
- Illegal transitions throw (spot-check: `captured → launching`, `active → capturing`,
  any transition **out of** a terminal state).
- `requestClone` for a user without the entitlement → rejected; for `direct` egress
  without premium → rejected (both with a clear reason, both audited as refusals).
- Relay mode with an unhealthy relay → the job terminates **failed before capture**,
  with the relay named as the cause.
- `panicStopAllDevices` on an active clone → session revoked, staging marked
  deletable, terminal audit row present — **using the same call as every other
  device action** (no clone-specific kill path in the diff).
- A `CloneJob` row inspected directly contains **no** secret-looking material
  (grep for cookie/key/token/plaintext).
- Re-running `advanceClone` on the same id does not double-execute a step.

## Verification (owner-run, deployed 2026-09-24)

**Deploy mechanics (`HOW_WE_MOVE_FAST.md` §2 — no schema change):**
`agent/task-109-clone-orchestrator` fast-forwarded into `main` (`9e09145`, pushed);
`rsync --files-from … --exclude='.env'` of `lib/clone.ts` + `lib/devices.ts`
(`clone-transport.ts`/`clone-settings.ts` were already byte-identical on the box);
`md5` on the VPS matches local exactly; built as `trmm` from `/opt/spaceworker`
(`✓ Compiled successfully`, exit 0); `spaceworker.service` restarted, active,
landing/login 200. `lib_clone_ts_*.js` is present in `.next/server/chunks`, so the
module really is in the deployed server bundle — this also resolves B2's note
("`clone-transport.ts` is intentionally absent from the SW build"): B3 imports it,
so it is now compiled and shipped. Zero new error lines in the journal.

**Live acceptance harness** (disposable: temp user + 2 temp devices + relay +
`clone-host` capability; every row deleted afterwards, then re-checked —
`CloneJob`/`RelayHealth`/`HostedBrowserSession` = 0/0/0, users back to 10, devices 2,
zero `browser-clone` or `panic_stop` audit rows left):

**57/57 PASS**, covering every acceptance line that does not need a physical Windows box:

- `captured → launching`, `active → capturing` and **every** transition out of a
  terminal state throw; terminals have zero outgoing edges; `active` has no pipeline
  edge; `deleted` is never reachable through the table (tombstone only).
- 6/6 refusals rejected **and audited** (`no_entitlement`, `direct_requires_premium`,
  `relay_not_registered`, `source_device_not_owned`, `bad_profile`, `bad_egress`); a
  refusal creates **no** `CloneJob`.
- `requestClone` → `CloneJob.status="requested"` with stamped idle/hard TTLs, plus the
  admission `DeviceJob` (`browser-clone:request`, queued → succeeded on a granted slot).
- **panic through the real HTTP route** (`POST /api/devices/panic`, minted session
  cookie): 200, `clonesRevoked: 1`, clone → terminal `revoked` with `revokedAt` +
  `purgeAfter`, terminal audit on the clone, one `panic_stop` audit carrying the clone
  counts, and the per-device `DeviceAudit` row — the same call every other device
  action uses (no clone-specific kill path).
- **relay fails closed before capture**, through the real Vantra transport: unknown
  agent → `relay_unreachable: vantra_404: Device not found. — relay must be up before
  capture`; job `failed`, **zero** capture jobs, no session row, no engine `cloneId`.
- write-ahead marker (`capturing`) re-entry → `interrupted_capturing`, step **not**
  re-executed; an unknown `pending` status throws and the row is left untouched.
- `deleteClone`: live record → throws; stranger → "not found"; terminal + owner →
  `deleted`; second call → `already_deleted`; `revokeClone` on a terminal record is a no-op.
- read model owner-scoped (`getClone` for a stranger → `null`); `expireClones` sweep is
  safe/idempotent on live data.
- no `CloneJob` row contains cookie/token/plaintext/password/jobkey material.

**Still owner-only (needs a physical Windows device):** real capture → receive → inject
→ launch → `active`; the `[INJECT CHECK 5]` resume path; a real relay-down refusal on a
device whose agent exists (this run proved the *unknown-agent* refusal); panic on a
**live** session (the run proved the pending/queued clone leg, which traverses the same
`revokeClonesForPanic` → `terminalEndClone` code). The parcel byte-hop gap noted in
`stepTransfer` is TASK_108 scope and unchanged.

## Report back

Files added · `tsc` result · the state union as implemented · how the governor wait is
represented · proof that panic was *extended* rather than duplicated · anything
unverified.

