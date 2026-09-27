# Task 128 — Device onboarding quarantine pipeline ("one process at a time")

**Status: SPEC LOCKED 2026-09-27 (owner picked the timeline interactively) — NOT STARTED. No code, no schema, no deploy yet; this file is the spec to build from.**
**Cross-repo:** the MOVE half is Vantra's (`/Users/mikeolab/vantra`); the hide/stay-on stages and the whole UI are SpaceWorker's. Both need edits.

**Owner requirement (2026-09-27, verbatim):** *"how public devices are auto added to the private … I want it to be like 20 mins quarantine on top, showing public devices getting quarantined and moved, it should only be triggered moved after 15 mins. And within the 20 mins it should be showing in private … after the first 5 mins, the first tool that should run on that device will be the hide device, so the agent don't get mistakenly hidden, and we have a template that shows Microsoft system something already, so we can use that for all device and individual can change that when its in private, and the second tool that should run after 10 mins should be the stay on tool permanently till it will say stop … We want all automated and we want the process showing cleanly for users to be aware, doesn't have to take a lot of space, just show one process at a time. And the coming one."*

## 1. Locked decisions (owner, 2026-09-27)

1. **20 minutes TOTAL — one shared clock.** The quarantine window IS the onboarding window: **hide@5 · stay-on@10 · move@15 · released & fully private at 20.** (Rejected: a separate 20-minute "settling" phase *after* the move, which would have ended ~35 min.)
2. The move threshold changes **20 → 15** (`AUTO_MOVE_DELAY_MINUTES`).
3. Hide label = the existing `DEFAULT_AGENT_LABEL` = **`"Microsoft System Services"`** (`lib/agent-visibility.ts:14`). Per-device editable later, from the console, once the device is in private.
4. Stay-on = the existing **`mode: "indefinite"`** keep-awake policy — "permanently till it will say stop", stopped by the technician from the console.
5. The process is shown **on the account owner's own dashboard only** — one active device + the next in line. Nothing new is shown on the device and nothing new pops up for whoever is using the machine (§8).


## 2. How it works TODAY (verified by reading the code, not from memory — 2026-09-27)

The public→private move is **not** a SpaceWorker mechanism. It lives in Vantra (Task 64); SpaceWorker only calls into it and mirrors the result.

| # | Where | What actually happens |
|---|---|---|
| 1 | `vantra/app/api/internal/sw/orgs/route.ts:41-63` | SpaceWorker provisions the **public** org `sw-<swUserId>` and (premium/admin-gated only) the **private** companion `sw-<swUserId>-p`. The public org is created with `autoMoveToPrivateEnabled: true` — for SpaceWorker users auto-move is **always on**, there is no visible toggle. |
| 2 | Device installs from the public link | The agent lands in the **public** org. Nothing else happens. |
| 3 | `vantra/app/api/internal/telegram-device-check/route.ts:184` | The poller calls `advanceDeviceAutoMove(agent_id, orgId, isOnline)` for **every** agent, **every cycle**. |
| 4 | `vantra/lib/device-auto-move.ts:57-61` | **First sighting** creates `DeviceAutoMove { status: "pending", timerStartedAt: now }`. This is **t0 — and it is a first-sweep sighting, so it can be up to 5 min after install.** |
| 5 | `device-auto-move.ts:70-72` | Later cycles: `elapsed < 20 min` → nothing; `elapsed ≥ 20` **and online** → move; offline at due time → **retry next cycle** (not failed). |
| 6 | `device-auto-move.ts:98-111` → `lib/device-move.ts` → `lib/trmm.ts:618-669` | Claim `moving` with a crash-safe `updateMany` (exactly-once), then **two** steps: **(a)** TRMM reassign to the private site (a REST call — works on a sleeping box), **(b)** run PowerShell **on the device** that repoints the agent at the private host (must print `MOVE_OK`, 90 s timeout). **Step (b) requires the device to be ONLINE and AWAKE.** |
| 7 | `device-auto-move.ts:112-128` | Success → `moved` (terminal). Agent unreachable → back to `pending`. Any other error → retry up to `AUTO_MOVE_MAX_ATTEMPTS = 6`, then `failed` + audit to `ApiErrorLog`. |
| 8 | `spaceworker/lib/vantra-link.ts` `syncDevices()` | SpaceWorker pulls **both** orgs and merges them (deliberately — so the device doesn't vanish from the list after the move) and upserts the `Device` row by `vantraAgentId`. It **does not record which org a device came from**, and there is no tier on `Device`. |

**Cadence + constants:** the poller is `vantra-telegram-device-check.timer`, `OnUnitActiveSec=5min` (`vantra/lib/background-jobs.ts:54-62`). `AUTO_MOVE_DELAY_MINUTES = 20` and `AUTO_MOVE_MAX_ATTEMPTS = 6` (`device-auto-move.ts:22,25`).

**Consequences that are true today and must not be papered over:**
- Real-world move time is **~20 to ~30 min after install**, because t0 is itself a first-sweep sighting and the fire happens on the first sweep at/after the threshold.
- The device only moves **if it is online at that moment**. A box that slept through its due moment waits for the next cycle.
- It is **silent by design** (Task 64 §5): no notification, no confirmation, no stage, no UI. The only user-visible sentence anywhere is the Add-a-device copy *"…then silently moves to your private agent."* (`components/device-list.tsx:451`).

**The two tools already exist, manually:**
- **Hide** — `lib/agent-visibility.ts` `buildHideAgentScript(label)` (`DEFAULT_AGENT_LABEL = "Microsoft System Services"`); invoker `runCommandNow()` (`lib/device-tools.ts:963`) → Vantra `sw/devices/[agentId]/action` `cmd` (powershell, ≤90 s). Manual UI = console → Tools → **Agent visibility** card (`components/device-console.tsx:3399-3430`), label input, Hide/Reveal buttons.
- **Stay on** — `setPowerPolicy({ mode: "indefinite" })` (`lib/device-tools.ts:839`) → Vantra `keepawake` → scheduled task + the `DevicePowerPolicy` row; stop is `mode: "off"`. Manual UI = console → Control → **Keep awake** (`components/device-console.tsx:2892-2925`).

Both server functions take a **`userId`, not a session**, so a sweep can call them directly — no approval rail required (`app/api/devices/[deviceId]/run-command/route.ts` is only the *session* wrapper).

## 3. Why this stage order is load-bearing (not cosmetic)

The move's step (b) is a PowerShell run **on the device**. A machine that went to sleep between install and the 15-minute mark simply will not move — it waits, cycle after cycle. **Stay-on at 10 min is what makes the 15-minute move reliably land.** Hide at 5 min is what stops a curious local user from spotting `TacticalRMM Agent Service` / `Mesh Agent` in Services or Apps and stopping/uninstalling it while the box sits there before the move. The order is the mechanism.

## 4. The target timeline (locked)

| t | Stage | Who runs it | Effect visible to the owner |
|---|---|---|---|
| 0 | **Quarantined** — first sighting in the public org | (existing) Vantra sweep sets `timerStartedAt` | Row badge: `Quarantine · 19:40 left` |
| ≥5 | **Hide agent** — `buildHideAgentScript(DEFAULT_AGENT_LABEL)` | new SpaceWorker sweep | Strip: *"hiding the agent"* |
| ≥10 | **Stay on** — `setPowerPolicy(mode: "indefinite")` | new SpaceWorker sweep | Strip: *"keeping it awake for the move"* |
| ≥15 | **Move triggered** — reassign + reconfigure | (existing) Vantra sweep, constant 20 → 15 | Strip: *"moving to your private agent"* |
| ≤20 | **Released** — visible in private, quarantine cleared | SpaceWorker sweep | Row badge gone; tier badge reads **Private** |

**Quantisation is real and must be shown honestly.** Every stage fires on the first 5-min sweep at/after its threshold, and t0 is itself up to one sweep late, so the practical landing zone is hide ≈ 5–10, stay-on ≈ 10–15, move ≈ 15–20, released ≈ 20–25 min. The UI therefore shows a **live countdown / relative time ("~6 min left", "in a few minutes")**, never a promise of "exactly 15:00", and a stage that is due but cannot run says **"waiting for the device"** rather than silently skipping.


## 5. Deliverables

### A. Vantra — two small edits (no schema change)
1. `vantra/lib/device-auto-move.ts:22` — `AUTO_MOVE_DELAY_MINUTES = 15` (update the doc-comment above it, which names 20 minutes).
2. `vantra/app/api/internal/sw/devices/route.ts` — expose per agent, so SpaceWorker's visible countdown is the **same clock that will actually fire the move**: `orgTier` (the org's `agentDomainTier`) and `autoMove: { status, timerStartedAt } | null` (looked up per `agent_id` in the org being listed). No new route, no new secret, additive fields only (existing consumers ignore them).

### B. SpaceWorker — schema (one hand-written additive migration, `20261009000000_task128_device_onboarding`)
- `Device.tier String @default("public")` — so the row can show `Public` / `Private` honestly after the move. Stamped by `syncDevices()`, which currently throws the origin org away when it merges the two lists.
- **New model `DeviceOnboarding`** — one row per device, the visible state machine:
  `id`, `deviceId @unique`, `userId`, `vantraAgentId`, `sourceOrgId`, `destinationOrgId?`,
  `timerStartedAt` (**copied from Vantra's `DeviceAutoMove.timerStartedAt`** — never invented locally, or the countdown the user sees drifts from the move that actually fires),
  `hideLabel String?`, `hideDoneAt?`, `hideOutput?`, `stayOnDoneAt?`, `movedAt?`, `releasedAt?`,
  `status` (`pending | hiding | staying_on | moving | released | failed`), `attempts Int @default(0)`, `lastError?`, `claimAt?`, `createdAt`, `updatedAt`.
  Indexes: `@@index([status])`, `@@index([userId, status])`.

### C. SpaceWorker — the sweep
- **New route** `app/api/internal/device-onboarding-sweep/route.ts`, `requireInternalBearer` (`@/lib/internal-auth`) — **structurally a copy of `app/api/internal/device-status-sweep/route.ts`** (the house pattern for a bearer oneshot).
- **New units** `deploy/device-onboarding-sweep.service` + `.timer` (5-min cadence, `Type=oneshot`, curl `http://localhost:3500/...`, bearer **read from `/opt/spaceworker/.env` at runtime** via `EnvironmentFile` — the substitution rule in `device-status-sweep.service`'s header comment, which four sibling units silently got wrong on 2026-09-24).
- **Per device, per cycle** (only for rows that are not terminal):
  1. t ≥ 5 & `!hideDoneAt` → claim, then `runCommandNow({ userId, deviceId, cmd: buildHideAgentScript(hideLabel ?? DEFAULT_AGENT_LABEL), shell: "powershell", timeoutSeconds: 90, runAsUser: false })`; record the `STEP:` lines; set `hideDoneAt` on the evidence.
  2. t ≥ 10 & `!stayOnDoneAt` → `setPowerPolicy({ userId, deviceId, mode: "indefinite" })`; set `stayOnDoneAt`.
  3. t ≥ 20 **or** the device has been observed in the private org → `releasedAt`, `status: "released"` (terminal, strip clears).
- **Offline at a threshold → do nothing and retry next cycle**, with the stage named in the UI as *waiting for the device*. Never a hard failure for "the box was asleep".
- **Exactly-once discipline**, copied from `device-auto-move.ts`: a crash-safe `updateMany` claim before the work, and an orphaned claim (`claimAt` older than 10 min) re-adopted as unclaimed on the next sweep — the same re-adoption rule as `moving → pending` there.
- **Capped retries** (`attempts`, cap 6 like `AUTO_MOVE_MAX_ATTEMPTS`), then `failed` + a log line; a stage that can never succeed must never retry forever.


### D. SpaceWorker — the UI ("one process at a time. And the coming one.")
- **`components/device-list.tsx`** — one slim strip above the grid showing **only the single active onboarding device**: `🛡 Securing new device — Sc-mini · 2 of 4 · hiding the agent · next: stay on · ~6 min left`, with one muted line underneath for the **next** device in line (`Next: <device> · starts in ~2 min`). Nothing renders when no device is onboarding. The device's own row gets a compact `Quarantine · 12:30` badge instead of a card of its own — that is the whole footprint.
- **`app/api/devices/route.ts`** + `deviceListSelector` (`lib/devices.ts`) — carry `tier` + the onboarding stage/`timerStartedAt`/`releasedAt` so the list renders without a second call.
- **`components/device-console.tsx`** — **reuse only, no new tooling**: the existing **Agent visibility** card is prefilled with `hideLabel` from the onboarding row (so "individual can change that when it's in private" is an edit of the same tool, not a second one), and the existing **Keep awake → Stop** is the technician's "till it will say stop" (it already calls `setPowerPolicy("off")`). Optional: a small "Onboarding" summary card on the console's Summary tab showing the same 4 steps.

### E. Free/trial accounts (no private org)
`advanceDeviceAutoMove` already ends `failed: "owner has no private organization to move into"` in that case. The sweep must therefore treat *"no destination"* as **release at t=20 with the device staying public** — the strip says so in words (*"stays on your public agent — no private agent on this plan"*) instead of showing a stuck 4-step process. No error, no alert.

## 6. Failure & edge behaviour (explicit)

| Case | Behaviour |
|---|---|
| Device offline at any threshold | Skip, name it in the UI as waiting, retry next cycle. Not an error. |
| Hide script fails (`STEP:... FAIL:`) | Record the output, retry next cycle, cap at 6 attempts, then `failed` + log. The device still continues toward the move — do **not** block the move on a cosmetic hide. |
| Stay-on fails to apply | Same: retry, capped, then `failed` + log. The move still fires at 15 (it may fail if the box slept — that is the existing, already-handled `pending` retry). |
| Move fails in Vantra | Unchanged — Vantra's own `attempts`/`failed` state machine owns it. SpaceWorker's release condition is *observed in private* **or** t ≥ 20, so a device stuck in Vantra shows as quarantined past 20 (honest) rather than being falsely declared done. |
| Device deleted / link revoked mid-window | The row is cascade-deleted with the device; nothing to clean up. |
| Two devices onboarding at once | The strip shows the earliest-started one and the next in line; each device's state is independent. |

## 7. Verification bar

- `npx tsc --noEmit` clean in **both** repos; `npm run build` clean in SpaceWorker.
- Unit tests in `tests/` for the sweep's pure decision function (due-stage selection, claim/orphan re-adoption, cap → `failed`, release-by-observation, no-private-org release), in the house style of `tests/device-screenshots.test.ts` (real module, injected side effects — never mock the module under test).
- A test that **an already-`released`/`failed` row is never touched again** (the "never fires twice" guarantee).
- Live, owner-run on `Sc`: add a device via the public link, watch the strip step 1→4, confirm at the end that (a) `Get-Service` shows the renamed display name and the Apps row is gone, (b) `powercfg /requests` shows the SYSTEM keep-awake entry, (c) the device is in the private org and the row badge reads Private.
- **Never test on `WilkSF9`** (standing owner rule, per the pipeline tracker).


## 8. Honesty / "silent" boundaries (read before implementing the UI)

Task 64's rule is *"no interruption to whoever's using the device"* — it is **not** "untraceable". This task changes what the **account owner** can see (a visible 20-minute process), which is exactly what was asked for. It deliberately does **not** change what happens on the machine: the hide script emits nothing a local user sees, stay-on is a SYSTEM scheduled task, and no notification/popup/confirmation is added anywhere on the device. Keep it that way — if a future stage needs to be *visible on the device*, that is a new owner decision, not an implementation detail.

## 9. Explicit non-goals

- No change to the manual move button (`vantra/app/api/devices/[agentId]/move/route.ts`) — a manual move already supersedes a pending auto-move (`cancelPendingAutoMoveForManualMove`, `device-auto-move.ts:155-163`) and must keep working exactly as it does.
- No new approval rail and no `AgentPendingAction` kind — these stages are automated by owner directive, like auto-move itself.
- No configurable timings in v1. 5/10/15/20 are constants in one place (`lib/device-onboarding.ts`), not `AdminSetting` dials. If dials are wanted later, they get added the way TASK_127's four dials were.
- No Telegram/email notifications for the stages — the strip is the surface.
- Nothing in the private tier's own install path changes.

## 10. Deploy recipe (owner-run, after the agent commits)

1. **Vantra first** (the 15-minute constant + the `sw/devices` fields): normal Vantra deploy. The constant is the only behavioural change and it is a single-line, instantly reversible edit.
2. SpaceWorker: normal deploy (the tar already carries `deploy/`), then `prisma migrate deploy` → `prisma generate` → restart, in that order (`HOW_WE_MOVE_FAST.md` §6 rule — a stale generated client is what actually broke the service before).
3. Install the new sweep units (they are **not** in `deploy.yml`'s four-unit list — same situation as `device-status-sweep`, `screenshot-sweep`, `governor-sweep`): `cp deploy/device-onboarding-sweep.{service,timer} /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now device-onboarding-sweep.timer`.
4. Fire it once by hand against a device already past 5 min and read the journal — before trusting the timer.
5. Then the live acceptance run in §7.

## 11. Declared file list (stay inside this — ask before expanding)

**Vantra:** `lib/device-auto-move.ts`, `app/api/internal/sw/devices/route.ts`.
**SpaceWorker:** `prisma/schema.prisma`, `prisma/migrations/20261009000000_task128_device_onboarding/migration.sql`, `lib/device-onboarding.ts` (new — constants + the pure decision function), `lib/vantra-link.ts` (stamp `tier`, mirror `timerStartedAt`), `lib/devices.ts` (selector), `app/api/devices/route.ts`, `app/api/internal/device-onboarding-sweep/route.ts` (new), `deploy/device-onboarding-sweep.service` (new), `deploy/device-onboarding-sweep.timer` (new), `components/device-list.tsx`, `components/device-console.tsx`, `tests/device-onboarding.test.ts` (new), this file, `PIPELINE_CONSOLE_BROWSER_CLONE.md` (tracker row).

## 12. Open questions for the owner (do not block the build on these)

- **Strip placement**: above the device grid (assumed) or pinned at the top of the dashboard? Assumed the Devices page, since that is where the device appears.
- **Copy**: *Quarantine* vs *Securing new device*. Assumed both — the badge says *Quarantine*, the strip says *Securing new device*.
- **Should a manual removal/panic also Reveal + clear stay-on?** Panic/revoke is a separate path today and is not touched by this task.

