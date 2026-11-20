# TASK 227 — New-device-added notification — execution steps & handoff

**Branch:** `agent/task-227-new-device-notification` (off `origin/main` @ `c9aa516`)

## What was built (§2 scope, exact)

`recordHeartbeat`'s **create branch** (first sight of a Vantra agent id = a new
device joining the account) now fires **exactly one** best-effort notification
through the existing per-channel `notifyUser(userId, {...})` fan-out
(`eventType: "device_added"`, subject + email/telegram/agent text with the
device name). The notify call is inside `try/catch` and runs **after** the
Device + heartbeat rows are written, so a channel failure never fails the
heartbeat (same shape as the device-status sweep).

Scope guards held:
- **update branch untouched** — no notifications on later heartbeats (pinned).
- **Master `deviceTelemetryEnabled` switch unchanged** — still throws
  `telemetry_disabled` before anything else (pinned).
- **Sweep untouched** — its `prev !== null` skip is pinned by a static test.
- **`ensureHostedDestination` never hits the notification path** — it creates
  the pseudo-device row directly, never via heartbeat (pinned).

New preference: `User.notifyDeviceAdded Boolean @default(true)` — silences the
ping WITHOUT blocking device creation (pinned). Wired through all five spots of
`PATCH /api/settings/notifications` (zod schema, refine, data merge, select,
prefs payload), the settings page pass-through, and a "New device added" toggle
in `components/notifications-settings.tsx` (disabled while the master telemetry
switch is off, matching offline/online).

## Files changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | `notifyDeviceAdded` column + comment (next to offline/online pair) |
| `prisma/migrations/20261127000000_task227_notify_device_added/migration.sql` | **new** — additive `ALTER TABLE` only |
| `lib/devices.ts` | `notifyUser` import, owner select + pref gate, try/catch notify block in create branch |
| `app/api/settings/notifications/route.ts` | 5 spots: schema / refine / data / select / payload |
| `app/dashboard/settings/page.tsx` | pref pass-through into `<NotificationsSettings>` |
| `components/notifications-settings.tsx` | interface field + "New device added" toggle |
| `tests/task-227-new-device-notification.test.ts` | **new** — 8 tests |

## Exact migration SQL (pasted from the file)

```sql
-- TASK_227 — new-device-added notification pref (User.notifyDeviceAdded).
-- ADD-COLUMN-ONLY by design: one BOOLEAN NOT NULL with a server-side DEFAULT on
-- an existing table. Every existing row is backfilled by the DEFAULT in the
-- same statement — no data rewrite, no table/index/FK touched, so it cannot
-- break unrelated tables. (House pattern — see 20261125000000_task169_email_*.)

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "notifyDeviceAdded" BOOLEAN NOT NULL DEFAULT true;
```

## Tests (8) — all against the REAL modules via the house require hook

1. First heartbeat of a new `vantraAgentId` → `created: true`, **exactly one**
   `device_added` notification, name interpolated in subject/email/telegram.
2. Later heartbeats of the same device → `created: false`, still one
   notification total, heartbeat write unaffected.
3. `notifyDeviceAdded=false` → device still created, **zero** notifications.
4. `notifyUser` throws → heartbeat still resolves (best-effort pin).
5. `ensureHostedDestination` → device row created, **zero** notifications,
   no `vantraAgentId`.
6. Master `deviceTelemetryEnabled=false` → rejects `telemetry_disabled`,
   nothing created, nothing notified.
7. PATCH route round-trip: accepts `notifyDeviceAdded: false`, returns it in
   `prefs`, persists via `user.update`; refine still 400s an empty body.
8. Static pins: sweep `prev !== null` intact; toggle rendered; page pass-through.

## Gate evidence

| Gate | Result |
|---|---|
| `npx prisma validate` | valid ✅ |
| `npx prisma generate` | ran (client sees new column) |
| `npx tsc --noEmit` | **exit 0** (after `rm -rf .next` — a stale TASK_226-build validator artifact referenced `stall-info`, which is not on this branch) |
| eslint touched files | **0 issues** |
| `npm test` | **1685 tests / 1684 pass / 0 fail / 1 skip** (floor 1677) |
| `CI=true npm run build` | **exit 0**; `/api/settings/notifications` in manifest |

## ⚠️ OWNER — migration + redeploy required (§7)

The migration has **not** been applied anywhere. This is the first of the batch
with a schema change, so the deploy order matters:

1. Merge → deploy runs `npx prisma migrate deploy` (applies
   `20261127000000_task227_notify_device_added` — additive, instant, safe).
2. Then the app restart picks up the new client.

**Why order matters:** `lib/devices.ts` now selects `notifyDeviceAdded` in the
heartbeat path — until the column exists, **every heartbeat would throw
P2022** (Prisma "column does not exist"). Code and migration must ship
together; never deploy the code without running the migration first.

Local dev: `npx prisma migrate deploy` (or `db:push`) + `npx prisma generate`.

## DEPLOYED & VERIFIED — 2026-10-19 (senior verification agent)
Merged to main (c0b56f2) with 226/228; merged-tree gates tsc 0 · lint 0 · 1642/1641/0 fail · build ✓. Shipped by SW dispatch 39138493191. Migration 20261127000000_task227_notify_device_added applied by the deploy (verified in _prisma_migrations + column count = 1 on User). notifyDeviceAdded present in deployed server chunks. Regression: heartbeat path untouched except the create-branch notify (sweep prev!==null pin intact per the branch's own tests, suite green on merged tree).
