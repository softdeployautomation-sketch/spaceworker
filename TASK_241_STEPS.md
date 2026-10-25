# TASK_241 — "device added" notification (public Everwas + private)

Branch: `agent/task-241-device-added-notify` off `fcc05a5` (main after TASK_240).
Status: implemented + verified locally. **Not deployed.**

## Root cause

`device_added` was only emitted from `recordHeartbeat()` (`lib/devices.ts:201`),
reached solely by `app/api/devices/heartbeat/route.ts`. Real devices join through
`syncDevices()` (`lib/vantra-link.ts`), which `db.device.upsert`s with no
notification — for both public Everwas and private tiers. The owner's pref was on
(`notifyDeviceAdded=t`, telemetry/email/telegram/agent `t`); the code path simply
never ran. Offline alerts worked because the status sweep has its own event.

## Changes

1. **`prisma/schema.prisma`** — `Device.addedNotifiedAt DateTime?` (after
   `onlineConfirmedAt`). The exactly-once claim for the "new device" ping.
2. **`prisma/migrations/20261201000000_task241_device_added_notify/migration.sql`**
   ```sql
   ALTER TABLE "Device" ADD COLUMN "addedNotifiedAt" TIMESTAMP(3);
   UPDATE "Device" SET "addedNotifiedAt" = "createdAt" WHERE "addedNotifiedAt" IS NULL;
   ```
   Add-column-only. The backfill is load-bearing: without it the first sync after
   deploy would fire a "new device" ping for every device already on the account.
3. **`lib/vantra-link.ts`**
   - `import { notifyUser } from "./notify"`.
   - `syncDevices()` reads the owner prefs once per sync
     (`notifyDeviceAdded`, `deviceTelemetryEnabled`).
   - After the upsert and `if (saved.removedAt) continue`, if
     `saved.addedNotifiedAt == null`: atomic
     `db.device.updateMany({ where: { id, addedNotifiedAt: null }, data: { addedNotifiedAt: now } })`.
     Only `count === 1` + pref + telemetry ⇒ `notifyUser(eventType: "device_added")`,
     subject `New device added (public|private): <name>`, same shape as the
     heartbeat ping, wrapped in try/catch so a dead channel cannot fail the sync.
   - Claim is stamped even when the pref is off, so enabling it later cannot
     replay devices the owner already has.
4. **`lib/devices.ts`** — heartbeat create path stamps `addedNotifiedAt: now`
   (it notifies inline); prevents the next sync from sending a second ping.
5. **Tests**
   - `tests/vantra-link-installer.test.ts` — harness gained a `./notify` recorder,
     `db.user.findUnique`, and an id-scoped null-guarded `db.device.updateMany`
     claim (the broad Everwas cleanup is a no-op). Six new tests: public Everwas
     ⇒ 1; private ⇒ 1 with label; second sync ⇒ still 1; pre-known row ⇒ 0;
     pref off ⇒ 0 but stamped; notify throws ⇒ sync still resolves.
   - `tests/task-227-new-device-notification.test.ts` — asserts the heartbeat
     create stamps the claim; header corrected (recordHeartbeat is no longer the
     only join path).

## Verification

- `tsc --noEmit` → 0.
- `eslint` on all four changed source/test files → 0.
- `prisma validate` → valid.
- Focused: 126 pass / 2 fail — both are the known TASK_179 baseline failures.
- Full suite: **1798 tests / 1790 pass / 7 fail / 1 skipped**.
  Baseline on `fcc05a5`: 1792 / 1784 / 7 / 1. Delta: +6 tests, +6 pass, same 7.
  The 7 are exactly the known ones: move-to-private ×5 and TASK_179 ×2.

## Deploy (only on explicit go)

Merge to main → push → `gh workflow run "Build & Deploy"` (workflow_dispatch) →
verify BUILD_ID mtime, migration `20261201000000_task241_device_added_notify`
applied, services active. Then add a device and confirm one
`New device added (public|private): <name>` notification; a second sync must not
repeat it.

## Notes

- Latency: the onboarding sweep syncs every 60s and a dashboard open syncs
  immediately — same cadence as offline alerts. No Vantra change needed.
- Scope: no routes, no UI, no `app/api/clones/**`, no `lib/clone.ts` gates, no
  WOL changes.
