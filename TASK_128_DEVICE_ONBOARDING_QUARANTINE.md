# Task 128 — Device onboarding quarantine pipeline ("one process at a time")

**Status: READY FOR BUILD — assigned to Cline, 2026-09-27. Spec LOCKED with the owner (timeline picked interactively); timeline, constants, stage order and copy in this file are SETTLED — build to them, do not re-litigate. Owner (Claude) verifies the diff and runs the deploy.**
**Branch: `agent/task-128-device-onboarding-quarantine` in BOTH repos** (already created in SpaceWorker; create it in Vantra).
**Cross-repo:** the MOVE half is Vantra's (`/Users/mikeolab/vantra`); the hide/stay-on stages and the whole UI are SpaceWorker's. Both need edits.

## 0. Read first (mandatory before writing a line)

- `PIPELINE_CONSOLE_BROWSER_CLONE.md` → **STANDARD AGENT CONTRACT** (top of file) and the **BUILD-11** row.
- `HOW_WE_MOVE_FAST.md` — §1 (repo root vs `app/`), §6 (gotchas; append-only).
- **Vantra (read, then edit):** `vantra/lib/device-auto-move.ts` (the whole file — it is the state machine you are re-timing), `vantra/app/api/internal/telegram-device-check/route.ts:177-195` (where the sweep is called), `vantra/app/api/internal/sw/devices/route.ts` (the response you extend), `vantra/lib/device-move.ts` + `vantra/lib/trmm.ts:618-669` (`moveAgentToSite` — the two-step move).
- **SpaceWorker (read, then edit):** `app/api/internal/device-status-sweep/route.ts` + `deploy/device-status-sweep.{service,timer}` (**the pattern you copy**), `lib/device-tools.ts` `runCommandNow` (:963) and `setPowerPolicy` (:839) (**call these directly — do not build new transports**), `lib/agent-visibility.ts` (`buildHideAgentScript`, `DEFAULT_AGENT_LABEL`), `lib/vantra-link.ts` `syncDevices()` (:669-745 — where `tier` and the t0 mirror go), `lib/devices.ts` (`deviceListSelector`), `components/device-list.tsx`, `components/device-console.tsx` (:2892 keep-awake, :3399 agent visibility), `tests/device-screenshots.test.ts` (**the test style to copy**), `prisma/migrations/20261008000000_task127_device_screenshots/migration.sql` (**the migration style to copy**).

## 0.1 The build contract (non-negotiable — same as every bit in this pipeline)

> **COMMIT ONLY. DO NOT DEPLOY.** No VPS, no ssh, no `.env`, no `prisma migrate deploy`, no `npm run build` on the server.
> - Work on `agent/task-128-device-onboarding-quarantine` (both repos).
> - **Hand-write the migration SQL.** Never `prisma migrate dev`; mirror `20261008000000_task127_device_screenshots/migration.sql` exactly (explicit column order, `CONSTRAINT "<Table>_pkey"`, `CREATE INDEX "<Table>_<cols>_idx"`, FKs added in a trailing `ALTER TABLE` block).
> - `npx tsc --noEmit` clean in **both** repos.
> - Never write JSX or PowerShell through a shell heredoc — use the file editor, then verify.
> - Stay inside §11's declared file list. If you must go outside it, **stop and ask**.
> - Finish by reporting: files changed per repo, `tsc` result per repo, tests run + result, and anything you could not verify locally.
> - Update the BUILD-11 row's trailing text to `BUILT on branch — not deployed` and add one line to the tracker's Status log.

**Owner requirement (2026-09-27, verbatim):** *"how public devices are auto added to the private … I want it to be like 20 mins quarantine on top, showing public devices getting quarantined and moved, it should only be triggered moved after 15 mins. And within the 20 mins it should be showing in private … after the first 5 mins, the first tool that should run on that device will be the hide device, so the agent don't get mistakenly hidden, and we have a template that shows Microsoft system something already, so we can use that for all device and individual can change that when its in private, and the second tool that should run after 10 mins should be the stay on tool permanently till it will say stop … We want all automated and we want the process showing cleanly for users to be aware, doesn't have to take a lot of space, just show one process at a time. And the coming one."*

## 1. Locked decisions (owner, 2026-09-27)

1. **20 minutes TOTAL — one shared clock.** The quarantine window IS the onboarding window: **hide@5 · stay-on@10 · move@15 · released & fully private at 20.** (Rejected: a separate 20-minute "settling" phase *after* the move, which would have ended ~35 min.) **Amended 2026-09-27 — the 20 is a PLAN, not a deadline: see §13.** A device still public at 20 gets "a little wait" and keeps retrying; only a 35-minute ceiling turns that into a visible failure.
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
| ≥5 | **Hide agent** — `buildHideAgentScript(DEFAULT_AGENT_LABEL)` | new SpaceWorker sweep | Strip step 2 |
| ≥10 | **Stay on** — `setPowerPolicy(mode: "indefinite")` | new SpaceWorker sweep | Strip step 3 |
| ≥15 | **Move triggered** — reassign + reconfigure | (existing) Vantra sweep, constant 20 → 15 | Strip step 4 |
| ≤20 | **Released** — visible in private, quarantine cleared | SpaceWorker sweep | Row badge gone; tier badge reads **Private** |
| 20–35 | **Overrun** — still public, so it keeps waiting and retrying (§13) | (existing) Vantra sweep | Strip: *"taking a little longer than usual"*; row badge: `Quarantine · taking longer` |
| ≥35 | **Ceiling** — still public ⇒ visible failure, never silent (§13) | SpaceWorker sweep | Red `Setup failed` badge + a page alert naming the device |

**The strip's exact wording is defined once, in §5.1 Part 3.1** (`onboardingView`) — that table is the authority and these step numbers map to it 1:1. Do not copy stage strings into components.

**Quantisation is real and must be shown honestly.** Every stage fires on the first 5-min sweep at/after its threshold, and t0 is itself up to one sweep late, so the practical landing zone is hide ≈ 5–10, stay-on ≈ 10–15, move ≈ 15–20, released ≈ 20–25 min. The UI therefore shows a **live relative time** — the strip shows the **next stage's ETA** (hide/stay-on/move), *not* the end of the plan, because that is the next thing that will actually happen — never a promise of "exactly 15:00". A stage that is due but cannot run says **"waiting for the device"** rather than silently skipping, and a window past the plan says **"taking a little longer than usual"** rather than counting up from zero (§13).


## 5. Deliverables

### A. Vantra — two small edits (no schema change)
1. `vantra/lib/device-auto-move.ts:22` — `AUTO_MOVE_DELAY_MINUTES = 15` (update the doc-comment above it, which names 20 minutes).
2. `vantra/app/api/internal/sw/devices/route.ts` — expose per agent, so SpaceWorker's visible countdown is the **same clock that will actually fire the move**: `orgTier` (the org's `agentDomainTier`) and `autoMove: { status, timerStartedAt } | null` (looked up per `agent_id` in the org being listed). No new route, no new secret, additive fields only (existing consumers ignore them).

### B. SpaceWorker — schema (one hand-written additive migration, `20261012000000_task128_device_onboarding`)
- `Device.tier String @default("public")` — so the row can show `Public` / `Private` honestly after the move. Stamped by `syncDevices()`, which currently throws the origin org away when it merges the two lists.
- **New model `DeviceOnboarding`** — one row per device, the visible state machine:
  `id`, `deviceId @unique`, `userId`, `vantraAgentId`, `sourceOrgId`, `destinationOrgId?`,
  `timerStartedAt` (**copied from Vantra's `DeviceAutoMove.timerStartedAt`** — never invented locally, or the countdown the user sees drifts from the move that actually fires),
  `hideLabel String?`, `hideDoneAt?`, `hideOutput?`, `stayOnDoneAt?`, `movedAt?`, `releasedAt?`,
  `status` (`pending | hiding | staying_on | moving | released | failed`), `attempts Int @default(0)`, `lastError?`, `claimAt?` (**diagnostic only — never a gate**; see §5.1 Part 3.1), `createdAt`, `updatedAt`.
  Indexes: `@@index([status])`, `@@index([userId, status])`.

### C. SpaceWorker — the sweep
- **New route** `app/api/internal/device-onboarding-sweep/route.ts`, `requireInternalBearer` (`@/lib/internal-auth`) — **structurally a copy of `app/api/internal/device-status-sweep/route.ts`** (the house pattern for a bearer oneshot).
- **New units** `deploy/device-onboarding-sweep.service` + `.timer` (5-min cadence, `Type=oneshot`, curl `http://localhost:3500/...`, bearer **read from `/opt/spaceworker/.env` at runtime** via `EnvironmentFile` — the substitution rule in `device-status-sweep.service`'s header comment, which four sibling units silently got wrong on 2026-09-24).
- **Per device, per cycle** (only for rows that are not terminal):
  1. t ≥ 5 & `!hideDoneAt` → claim, then `runCommandNow({ userId, deviceId, cmd: buildHideAgentScript(hideLabel ?? DEFAULT_AGENT_LABEL), shell: "powershell", timeoutSeconds: 90, runAsUser: false })`; record the `STEP:` lines; set `hideDoneAt` on the evidence.
  2. t ≥ 10 & `!stayOnDoneAt` → `setPowerPolicy({ userId, deviceId, mode: "indefinite" })`; set `stayOnDoneAt`.
  3. t ≥ 20 **or** the device has been observed in the private org → `releasedAt`, `status: "released"` (terminal, strip clears).
- **Offline at a threshold → do nothing and retry next cycle**, with the stage named in the UI as *waiting for the device*. Never a hard failure for "the box was asleep".
- **Exactly-once discipline**, copied from `device-auto-move.ts:98-102`: a crash-safe `updateMany` claim before the work (`where: { id, hideDoneAt: null }`, `claimed.count !== 1` → skip), and a **dead** claim — a row left in `hiding`/`staying_on` with its `*DoneAt` null by a request that died — re-adopted as unclaimed on the next sweep. That is the same unconditional `moving → pending` rule as `device-auto-move.ts:63-69`; **no staleness timer** (§5.1 Part 3.1). `claimAt` is written for observability only and is never a gate.
- **Capped retries** (`attempts`, cap 6 like `AUTO_MOVE_MAX_ATTEMPTS`), then `failed` + a log line; a stage that can never succeed must never retry forever.


### D. SpaceWorker — the UI ("one process at a time. And the coming one.")
- **`components/device-list.tsx`** — one slim strip above the grid showing **only the single active onboarding device**: `🛡 Securing new device — Sc-mini · 2 of 4 · hiding the agent · next: stay on · ~6 min left`, with one muted line underneath for the **next** device in line (`Next: <device> · starts in ~2 min`). Nothing renders when no device is onboarding. The device's own row gets a compact `Quarantine · 12:30` badge instead of a card of its own — that is the whole footprint.
- **`app/api/devices/route.ts`** + `deviceListSelector` (`lib/devices.ts`) — carry `tier` + the onboarding stage/`timerStartedAt`/`releasedAt` so the list renders without a second call.
- **`components/device-console.tsx`** — **reuse only, no new tooling**: the existing **Agent visibility** card is prefilled with `hideLabel` from the onboarding row (so "individual can change that when it's in private" is an edit of the same tool, not a second one), and the existing **Keep awake → Stop** is the technician's "till it will say stop" (it already calls `setPowerPolicy("off")`). Optional: a small "Onboarding" summary card on the console's Summary tab showing the same 4 steps.

### E. Free/trial accounts (no private org)
`advanceDeviceAutoMove` already ends `failed: "owner has no private organization to move into"` in that case. The sweep must therefore treat *"no destination"* as **release at t=20 with the device staying public** — the strip says so in words (*"stays on your public agent — no private agent on this plan"*) instead of showing a stuck 4-step process. No error, no alert.

## 5.1 BUILD STEPS — what to actually write, in this order

### Part 1 — Vantra (do this FIRST; it is the clock)

**1.1 `vantra/lib/device-auto-move.ts`**
- `AUTO_MOVE_DELAY_MINUTES`: `20` → `15` (line 22). Update the file-header comment (lines 9–19) and the constant's own doc-comment so they say 15, and add one sentence: *SpaceWorker runs a 20-minute onboarding window on this same clock (hide@5, stay-on@10); this constant is the move half of it.*
- **Change nothing else.** `AUTO_MOVE_MAX_ATTEMPTS`, the statuses, the claim/re-adoption logic and the destination resolution stay byte-identical — the smallness of this half is the point.

**1.2 `vantra/app/api/internal/sw/devices/route.ts`** — make the response carry the clock SpaceWorker will display:
- The org select currently reads `{ id: true, name: true, trmmClientId: true }` → add `agentDomainTier: true`.
- Before building the response, fetch the auto-move rows so each agent can carry its own clock:

```ts
const moves = await db.deviceAutoMove.findMany({
  where: { sourceOrgId: org.id },
  orderBy: { createdAt: "desc" },
  select: { agentId: true, status: true, timerStartedAt: true },
});
const moveByAgent = new Map<string, { status: string; timerStartedAt: string }>();
for (const m of moves) {
  if (!moveByAgent.has(m.agentId)) {
    moveByAgent.set(m.agentId, {
      status: m.status,
      timerStartedAt: m.timerStartedAt.toISOString(),
    });
  }
}
```

  (`orderBy createdAt desc` + first-wins = the **newest** row per agent, exactly what `advanceDeviceAutoMove` itself reads.)
- In the existing `devices.map(...)`, add two **additive** fields: `orgTier: org.agentDomainTier` and `autoMove: moveByAgent.get(a.agent_id) ?? null`.
- Keep `ok: true` and every existing field name byte-identical — SpaceWorker's `syncDevices` types this response inline, and the change must be purely additive.
- **Do not filter out `failed` rows.** A device whose auto-move failed must still report `status: "failed"` so the SpaceWorker side can stop showing it as stuck in progress (§5E).
- `db` is already imported; no new imports, no new route, no new secret.

### Part 2 — SpaceWorker schema + migration

**2.1 `prisma/schema.prisma` — `model Device`:** add
`tier String @default("public")`, with a doc comment saying it is stamped by `syncDevices()` from the org the agent was listed under — `"public"` until the Vantra auto-move lands, `"private"` after. Add the back-relation `onboarding DeviceOnboarding?` to the existing relations list.

**2.2 new model `DeviceOnboarding`** — exactly the columns listed in §5B, with doc comments in the house style, plus:

```
deviceId  String @unique
device    Device @relation(fields: [deviceId], references: [id])
userId    String
user      User   @relation(fields: [userId], references: [id])

@@index([status])
@@index([userId, status])
```

- **FK style: mirror `DeviceScreenshot` verbatim** — `ON DELETE CASCADE ON UPDATE CASCADE` for both, with the same kind of one-line justification (an onboarding row for a deleted device has nothing to preserve). Do not invent RESTRICT here; `DeviceScreenshot` is the newest device-child table and is the precedent.

**2.3 `prisma/migrations/20261009000000_task128_device_onboarding/migration.sql`** — hand-written and additive:
1. `ALTER TABLE "Device" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'public';`
2. `CREATE TABLE "DeviceOnboarding" (...)` with the columns in the datamodel's order and `CONSTRAINT "DeviceOnboarding_pkey" PRIMARY KEY ("id")`.
3. The two `CREATE INDEX` statements, named in the `"<Table>_<cols>_idx"` style.
4. The two trailing `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY` statements.
5. A short header comment stating this changes **no** existing behaviour: every existing device defaults to `tier = 'public'`, and no onboarding row exists until a device is next synced.

- Do **not** run `prisma migrate dev`. Running `npx prisma generate` **locally** is expected (so `tsc` sees the new model) — that is local-only and fine; never point it at production, and never run `prisma migrate deploy`.
### Part 3 — SpaceWorker: the timeline module, the sync, the sweep, the units

**3.1 New `lib/device-onboarding.ts`** — constants + ONE pure decision function + ONE display helper. No DB, no `server-only`, so the client component can import the helpers too.

```ts
export const ONBOARDING_HIDE_MINUTES = 5;
export const ONBOARDING_STAY_ON_MINUTES = 10;
export const ONBOARDING_MOVE_MINUTES = 15;   // DISPLAY only — the real move is Vantra's own clock
export const ONBOARDING_WINDOW_MINUTES = 20; // the PLAN — never a hard deadline
export const ONBOARDING_GRACE_MINUTES = 5;
export const ONBOARDING_CEILING_MINUTES = ONBOARDING_WINDOW_MINUTES + ONBOARDING_GRACE_MINUTES * 3; // 35
export const ONBOARDING_MAX_ATTEMPTS = 6;
export const ONBOARDING_ACCESSIBLE_NOTE =
  "You can keep using this device while it's being set up.";

export type OnboardingAction = "hide" | "stay_on" | "release" | "wait" | "fail" | "terminal";
export function nextOnboardingAction(input: {
  status: string; tier: string; timerStartedAt: Date;
  hideDoneAt: Date | null; stayOnDoneAt: Date | null;
  destinationOrgId?: string | null;
}, nowMs: number): OnboardingAction;
```

Rule order (evaluate top-down, first match wins — this exact order is the spec):
1. `status` is `released` or `failed` → `"terminal"`.
2. `tier === "private"` → `"release"` (it is observed in the private org).
3. `destinationOrgId === null` **and** `elapsed >= 20 min` → `"release"` (free/trial: the move can never happen, so it ends cleanly and can **never** be `fail`).
4. `elapsed < 5 min` → `"wait"`.
5. `!hideDoneAt` → `"hide"`.
6. `elapsed < 10 min` → `"wait"`.
7. `!stayOnDoneAt` → `"stay_on"`.
8. `elapsed >= 35 min` → `"fail"` (past the plan **and** its grace, still public).
9. otherwise `"wait"` — this is the 20–35 overrun: *still working*.

Note rules 5/7 precede rule 8 on purpose: a stage that is still **due** keeps being requested however long that takes, which is how an **offline** device retries indefinitely without any failure (§13).

**No staleness/`claimAt` window — copy Vantra deliberately.** Vantra re-adopts a dead claim *unconditionally*: `device-auto-move.ts:63-69` flips any `moving` row back to `pending` on the next poll, with no timer, precisely because claim → work → finish all happen inside **one** request and the poller is a single worker. This sweep has the same shape (one systemd oneshot at a time; `runCommandNow` completes inside the request), so it uses the same rule: a row still sitting in `hiding`/`staying_on` with its `*DoneAt` null at the start of a sweep is a *dead request*, and is simply re-claimed and re-run. The `*DoneAt` timestamp — not a claim clock — is what makes a stage exactly-once.

Also export a client-safe display helper (`onboardingView(row, nowMs)`) returning `{ step: 1|2|3|4; title: string; detail: string; remainingMs: number; elapsedMs: number; next: string | null; nextStageInMs: number | null; waitingForDevice: boolean; overrun: boolean; failed: boolean }` with **exactly these strings** (the UI must not invent its own copy):

| step | when | `title` | `detail` |
|---|---|---|---|
| 1 | elapsed < 5 min | `Quarantined` | `waiting for the first check-in` |
| 2 | hide due, not done | `Hiding the agent` | `so it can't be stopped from the machine` |
| 3 | stay-on due, not done | `Staying awake` | `keeping it reachable for the move` |
| 4 | elapsed ≥ 15 min, not released, in flight | `Moving to your private agent` | `almost done` |
| 4 | same, but **overrun** (20–35, still public) | `Moving to your private agent` | `taking a little longer than usual — still working, nothing is lost` |
| 4 | **failed** (terminal) | `Setup didn't finish` | `still on your public agent — you can keep using it` |
| 4 | no destination on the plan | `Moving to your private agent` | `stays on your public agent — no private agent on this plan` |

`onboardingClockText(view)` and `onboardingRowLabel(row, nowMs)` are exported from the **same** module so the Devices strip and the console card can never disagree; the row label returns `Setup failed` for a `failed` row and is **never** null for it (no silent failures — §13).

`waitingForDevice: true` whenever the current step is due but the device has not been seen recently (`isDeviceOnline(device.lastSeenAt)` from `lib/devices.ts` is false) — that is the "waiting for the device" wording in §4/§6.

**3.2 `lib/vantra-link.ts` `syncDevices()`** — stop discarding the origin org:
- Keep the two-org fetch. Build `Map<agentId, { row: SwAgentRow; orgId: string; tier: string }>` and stamp `tier` from the response's new `orgTier` field, falling back to list position (`orgIds[0]` = public, `orgIds[1]` = private) when Vantra has not been redeployed yet — **the fallback is deliberate and required**, so SpaceWorker works even if the Vantra half lands after it.
- The `Device.upsert` gains `tier` in both `update` and `create`.
- After each device upsert:
  - `tier === "private"` → if an onboarding row exists and is not terminal, set `releasedAt`/`status: "released"`.
  - `tier === "public"` → create the onboarding row if none exists: `timerStartedAt = autoMove?.timerStartedAt ?? now` (**never overwrite an existing row's `timerStartedAt`**), `hideLabel = DEFAULT_AGENT_LABEL`, `sourceOrgId`, `destinationOrgId = link.privateOrgId`. If the response's `autoMove.status === "failed"`, leave `lastError` set so §5E can word the "stays on your public agent" case.
- Extend the inline response type with `orgTier: string` and `autoMove: { status: string; timerStartedAt: string } | null` — additive, and the destructuring must tolerate `undefined` (older Vantra).
- Do not change the function's return shape or its error handling.





**3.3 New `app/api/internal/device-onboarding-sweep/route.ts`** — `POST`, `requireInternalBearer(req)` (401 otherwise), structured exactly like `device-status-sweep/route.ts` (per-device `try/catch` so one device can never abort the sweep for the rest; a one-line `console.log` summary at the end; `NextResponse.json({ ok: true, checked, acted })`).
- Load non-terminal rows: `db.deviceOnboarding.findMany({ where: { status: { notIn: ["released", "failed"] } }, include: { device: { select: { id: true, userId: true, name: true, tier: true, lastSeenAt: true } } } })`.
- Per row, `nextOnboardingAction(...)` then act. **Status transitions the agent must write** (keep this vocabulary exact — the list payload and the console read it): `pending` (idle / waiting) → `hiding` (hide claimed, in flight) → `pending` (hide done) → `staying_on` → `pending` → `moving` (set once when the window reaches 15 min, purely so the row records "move in flight"; **non-terminal**) → `released`. `failed` is reachable from either stage on the attempt cap, and from neither after `released`.
  - **`hide`** — claim atomically first, then run:
    ```ts
    const claimed = await db.deviceOnboarding.updateMany({
      where: { id: row.id, hideDoneAt: null },
      data: { status: "hiding", claimAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue; // already done by another sweep
    ```
    then `runCommandNow({ userId: device.userId, deviceId: device.id, cmd: buildHideAgentScript(label), shell: "powershell", timeoutSeconds: 90, runAsUser: false })` — the **exact** option names, verified against `lib/device-tools.ts:963`. `label = isValidAgentLabel(row.hideLabel) ? row.hideLabel : DEFAULT_AGENT_LABEL`. On success write `{ hideDoneAt, hideOutput: output.slice(0, 2000), status: "pending", claimAt: null, lastError: null }`; on throw write `{ status: attempts >= ONBOARDING_MAX_ATTEMPTS ? "failed" : "pending", claimAt: null, lastError }`.
  - **`stay_on`** — same claim shape keyed on `stayOnDoneAt`, then `setPowerPolicy({ userId: device.userId, deviceId: device.id, mode: "indefinite" })` (`lib/device-tools.ts:839`), then `{ stayOnDoneAt, status: "pending", claimAt: null }`. A `keep_awake_apply_failed` throw is retried, capped, exactly like the hide stage — **it must not block the move**, which is Vantra's and fires on its own clock regardless.
  - **`release`** — `{ releasedAt: new Date(), status: "released", claimAt: null }`, plus `movedAt` when `device.tier === "private"` at that moment.
- **Never call the session routes** (`app/api/devices/[deviceId]/run-command`) — call `runCommandNow`/`setPowerPolicy` directly; they take `userId` precisely so this works.

**3.4 New units** — copy `deploy/device-status-sweep.service`/`.timer` and change only what differs:
- `.service`: the `Description`, and the curl URL → `/api/internal/device-onboarding-sweep`. **Keep `EnvironmentFile=/opt/spaceworker/.env` and the `${INTERNAL_BEARER_TOKEN}` expansion character-for-character** — that runtime-read rule is what four sibling units got wrong on 2026-09-24 and silently 401'd.
- `.timer`: `OnUnitActiveSec=5min`, the `# Install: sudo cp …` header line, and a comment saying why 5 min (the stage thresholds are 5-minute-quantised by design, mirroring Vantra's own poller).

### Part 4 — SpaceWorker UI (one process at a time, plus the coming one)

**4.1 `lib/devices.ts` `deviceListSelector` + `app/api/devices/route.ts`** — add `tier` and the onboarding row (`status`, `timerStartedAt`, `hideDoneAt`, `stayOnDoneAt`, `releasedAt`, `lastError`) to the list payload so the strip renders with no second call. Keep every existing field name byte-identical.

**4.2 `components/device-list.tsx`** — the strip. Every constraint below is load-bearing:
- **One strip of the grid's width, not a card.** Show only the **single active** onboarding device (earliest `timerStartedAt` among non-terminal rows already in step 2/3/4) plus **one** muted "next up" line. If nothing is onboarding at all, render **nothing** — no empty shell, no placeholder.
- All copy comes from `onboardingView(...)` in `lib/device-onboarding.ts`. The component must not hard-code stage names.
- Shape: `🛡 Securing new device · <name> · 2 of 4 · hiding the agent · next: stay on · ~6 min left`, and a muted second line `Next: <name> · starts in ~2 min`. When `waitingForDevice`, replace the trailing time with `waiting for the device`.
- **Live countdown**: a 1-minute `setInterval` on mounted state is enough — do not add a websocket. The countdown must derive from `timerStartedAt` (server clock) so a reload never "jumps the clock back".
- The device's own row in the grid gets a compact badge (`Quarantine · 12:30`) — **not** a second card, and no per-row stage text. That is the entire footprint on the list.
- Respect the existing dark/light tokens and the grid's responsive breakpoints; reuse the existing badge/pill classes instead of introducing new CSS.

**4.3 `components/device-console.tsx`** — **reuse only, no new tooling**:
- The existing **Agent visibility** card (`:3399`) is prefilled from `hideLabel`, so the owner can rename it after the move — that is the "individual can change that when it's in private" requirement, met by the same tool the hide stage already used.
- The existing **Keep awake → Stop** (`:2892`) already calls `setPowerPolicy("off")` — that is the technician's "till it will say stop". Do **not** add a second stop.
- Optional, still inside the reuse rule: a small **Onboarding** summary card on the Summary tab using the same 4 step labels.

**4.4 Free/trial wording** — when the link has no `privateOrgId`, step 4's detail reads `stays on your public agent — no private agent on this plan` and the process still ends at 20 (§5E). Never show a stuck 4-step process.

### Part 5 — tests + docs

**5.1 `tests/device-onboarding.test.ts`** — the real module with injected side effects, in the house style of `tests/device-screenshots.test.ts` (never mock the module under test). Cover:
- every threshold boundary (±1 s around 5 / 10 / 20 min);
- the `hide` → `stay_on` → `release` ordering, including that `stay_on` cannot fire before `hide` is done;
- `tier === "private"` releasing early;
- a `released` / `failed` row always returning `terminal` — **the "never fires twice" guarantee**;
- a stage that already has its `*DoneAt` set never re-firing (the crash-safe claim), and a **dead** claim (row sitting in `hiding` with `hideDoneAt` null) being re-adopted on the next sweep;
- `attempts` reaching 6 → `failed`;
- the no-`privateOrgId` release path;
- `onboardingView` returning the **exact** strings from §3.1 at each step (a copy regression must fail the test).

**5.2 Docs** — `PIPELINE_CONSOLE_BROWSER_CLONE.md`: flip the **BUILD-11** row's trailing text to `BUILT on branch — not deployed` and append one Status-log line (date, branch, per-repo files, `tsc` result). `HOW_WE_MOVE_FAST.md` §6 gets a new gotcha **only if** you were actually bitten by one — append-only, never rewrite existing entries.

## 6. Failure & edge behaviour (explicit)

| Case | Behaviour |
|---|---|
| Device offline at any threshold | Skip, name it in the UI as waiting, retry next cycle. Not an error. |
| Hide script fails (`STEP:... FAIL:`) | Record the output, retry next cycle, cap at 6 attempts, then `failed` + log. The device still continues toward the move — do **not** block the move on a cosmetic hide. |
| Stay-on fails to apply | Same: retry, capped, then `failed` + log. The move still fires at 15 (it may fail if the box slept — that is the existing, already-handled `pending` retry). |
| Move fails in Vantra | Unchanged — Vantra's own `attempts`/`failed` state machine owns it, and SpaceWorker never retries the move. SpaceWorker's release condition is *observed in private* **or** (no destination **and** the plan reached), so a device that will never move still **ends at 20** (a bounded window, never an eternal strip). A device that *should* move but hasn't is **not** released at 20: it keeps waiting through the grace window and only goes terminal `failed` at the 35-minute ceiling (§13). Because `tier` is stamped from the org the agent is actually listed under, the row badge stays **`Public`** and the console surfaces the outstanding `lastError`. The strip never claims a move that did not happen, and the failure is never silent (red badge + page alert + console card). |
| Device deleted / link revoked mid-window | The row is cascade-deleted with the device; nothing to clean up. |
| Two devices onboarding at once | The strip shows the earliest-started one and the next in line; each device's state is independent. |

## 7. Verification bar

The unit-test list lives in **§5.1 Part 5** — that is the authority; do not invent a second test plan. The bar is:
- `npx tsc --noEmit` clean in **both** repos; `npm run build` clean in SpaceWorker.
- `tests/device-onboarding.test.ts` green, including the "never fires twice" guard and the exact-copy assertions.
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
**SpaceWorker:** `prisma/schema.prisma`, `prisma/migrations/20261012000000_task128_device_onboarding/migration.sql`, `lib/device-onboarding.ts` (new — constants + the pure decision function), `lib/vantra-link.ts` (stamp `tier`, mirror `timerStartedAt`), `lib/devices.ts` (selector), `app/api/devices/route.ts`, `app/api/internal/device-onboarding-sweep/route.ts` (new), `deploy/device-onboarding-sweep.service` (new), `deploy/device-onboarding-sweep.timer` (new), `components/device-list.tsx`, `components/device-console.tsx`, `tests/device-onboarding.test.ts` (new), this file, `PIPELINE_CONSOLE_BROWSER_CLONE.md` (tracker row).

## 12. Open questions for the owner (do not block the build on these)

- **Strip placement**: above the device grid (assumed) or pinned at the top of the dashboard? Assumed the Devices page, since that is where the device appears.
- **Copy**: *Quarantine* vs *Securing new device*. Assumed both — the badge says *Quarantine*, the strip says *Securing new device*.
- **Should a manual removal/panic also Reveal + clear stay-on?** Panic/revoke is a separate path today and is not touched by this task.

---

## 13. AMENDMENT — grace, retries and never-silent failures (owner, 2026-09-27, post-build)

**Owner requirement, verbatim:** *"yes fix every lapses and also let them be a fall back in case any of the timed stuff exceeds the plan time, it's not necessarily for it to be exactly 20 mins, if anyone exceeds, we just want to put a little wait in each processes, and also any failed attempt due to offline should retry, and any device pending in public should always remain accessible in that position for the user to do anything pending it moves to private. so any device doesn't fail silently."*

Five rules now govern the window. All are implemented and unit-tested.

**13.1 The 20-minute window is a PLAN, not a deadline.**
A device still public at 20 is **neither released nor failed**. It keeps its row, keeps its clock, and keeps being retried by Vantra's own poller. The UI words this **overrun** (*"taking a little longer than usual"*; badge `Quarantine · taking longer`) instead of counting up from zero or claiming a move that did not happen. `releasedAt` is now set **only** on a real release.
*Implementation:* rule 9 of `nextOnboardingAction` (`lib/device-onboarding.ts`), `view.overrun` in `onboardingView`.

**13.2 The ceiling is 35 minutes, and only there does "still public" become a failure.**
`ONBOARDING_CEILING_MINUTES = ONBOARDING_WINDOW_MINUTES + ONBOARDING_GRACE_MINUTES * 3` (20 + 15 = 35). Past it, with the device still public, the row goes terminal `failed` — with the reason recorded in `lastError` and `releasedAt` deliberately **left null** so a failure can never be read as a success.
*Implementation:* rule 8, the sweep's `action === "fail"` branch.

**13.3 Offline retries, and never burns an attempt.**
A due stage whose box is unreachable is **skipped and retried on every later cycle**, exactly as before — but this is now a tested guarantee rather than an accident of ordering: rules 5/7 (a stage still `*DoneAt`-null) are evaluated **before** the ceiling, so a device that is offline at 40, 90 or 600 minutes still returns `hide`, never `fail`, and `attempts` stays `0`. Only an **attempted** stage that actually failed counts toward `ONBOARDING_MAX_ATTEMPTS`.

**13.4 A device pending in public stays Public, listed, and fully usable.**
The quarantine runs **only** the two existing tools (hide, stay-on); it never moves the device, never locks it out, never changes its tier, and never removes it from the list or the console. `syncDevices()` is the only thing that changes `tier`, and only when Vantra reports the agent in the private org. The reassurance is rendered from one frozen string (`ONBOARDING_ACCESSIBLE_NOTE`) in both the strip and the console card: *"You can keep using this device while it's being set up."* Asserted by test.

**13.5 No device fails silently.**
A `failed` row is now **visible in three places** — this was the actual bug in the first build, where `isOnboardingTerminal` filtered `failed` rows out of the strip *and* the console card *and* the row badge, so a device that never moved simply reverted to a bare `Public`:
- the row keeps a **red `Setup failed` pill** (`onboardingRowLabel` never returns null for `failed`);
- the Devices page keeps a **red alert** naming the device(s) (*"… couldn't finish setup — still on your public agent and fully usable. Open the device to try again."*);
- the console's Summary card **renders for `failed` too** (red border, `Setup didn't finish`, plus `Last error: …`).
A free/trial device with **no destination** is the one case that ends as a clean `release` at the plan and is **never** `fail` — nothing was ever going to move, so there is nothing to fail at.

**13.6 Display fixes in the same pass.**
- **Step 1 is visible.** The strip no longer waits for step 2, so a public device being quarantined is on screen from its **first sweep** (`Quarantined · waiting for the first check-in`). This is what the owner asked for: *"showing public devices getting quarantined and moved."*
- **The clock shows the next stage's ETA**, not the end of the plan (`view.nextStageInMs`) — at step 2 the old wording read *"next: stay on · ~14 min left"*, which could be misread when stay-on was ≤5 min away.
- The clock/label copy moved **into `lib/device-onboarding.ts`** (`onboardingClockText`, `onboardingRowLabel`) so the strip and the console cannot drift apart.

**13.7 Migration renamed — `20261009000000` → `20261012000000`.**
The original name was chosen against a **stale local `main`** and sorted *before* an already-applied migration. Worse, the first fix (`20261011000000`) turned out to **collide** with a migration that is already on `origin/main` *and* applied on the VPS — `20261011000000_task127_screenshot_wake_delay` (commit `139dd4e`) — because the local repo's `main` was 2 commits behind `origin/main`. Reusing a prefix is how migration history diverges, so the folder now uses `20261012000000`, which is **strictly greater than every migration on `origin/main`**. Nothing has ever been applied anywhere from this branch, so plain `git mv` is sufficient (had it been applied, this would need `prisma migrate resolve`, not a rename). The SQL is unchanged and still purely additive. **Lesson, now recorded in `HOW_WE_MOVE_FAST.md` §6: always compare the new timestamp against `origin/main`, not local `main`.**




## 14. AMENDMENT — the sweep drives the sync itself (owner, 2026-09-27, post-deploy finding)

**14.1 The gap.** `DeviceOnboarding` rows are written by exactly one function — `syncDevices()` (`lib/vantra-link.ts:748`) — and that function had **no timer**: it ran when a human opened the device list. So the hide@5 and stay-on@10 stages only ever happened for users who happened to visit their dashboard, while Vantra's move fired on its **own** clock regardless. A freshly installed public device could therefore be **moved at 15 minutes having never been hidden and never been kept awake** — precisely the failure this task exists to prevent, and invisible in both directions (no row ⇒ `checked: 0` ⇒ the sweep reports success while doing nothing).

**14.2 The fix.** `device-onboarding-sweep` re-syncs every linked user **before** it acts: it loads `vantraLink.findMany({ where: { status: { not: "revoked" } }, select: { userId: true } })` and calls `await syncDevices(link.userId)` per user, best-effort, collecting failures into `syncErrors` (never thrown). Revoked links are skipped — they have no org. The response now reports `{ ok, synced, syncErrors, checked, acted }` so the timer's journal states **out loud** whether the automation half ran; a sweep that silently synced nobody is how this hid in the first place. This makes the pipeline genuinely automated (owner rule: *"we want all automated"*) and is what makes "no device fails silently" true for a device nobody has looked at yet.

**14.3 Concurrency hardening it required.** `DeviceOnboarding.deviceId` is UNIQUE and `syncDevices()` now has **two** callers that can overlap (the 5-minute sweep and a user's page load), so the `findUnique` → `create` pair can race. The loser's `P2002` is the desired end state (the row exists) and is now swallowed deliberately; **any other** error still throws and is recorded in the link's `lastError`. Same inline P2002 convention as `app/api/leads/merge/route.ts`.

**14.4 Scope note.** No new endpoint, unit or cron was added — the existing 5-minute oneshot does the sync. The `Device.tier` / countdown semantics are unchanged; §13 still governs grace, retries and visibility.

## 15. Change log

| Date | Change |
| --- | --- |
| 2026-09-27 | Built (Vantra `cb14182`, SpaceWorker `c9458a7`); merged with TASK_127 as `a7a7448`; deployed. |
| 2026-09-27 | §13 — grace (plan ≠ deadline, 35-min ceiling), offline retry never burns an attempt, Public stays usable, `failed` visible in three places, migration renamed to `20261012000000`. |
| 2026-09-27 | §14 — the sweep syncs linked users itself (+ `synced`/`syncErrors` in the response); the `P2002` race guard from having two sync callers. |
