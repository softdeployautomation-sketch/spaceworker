# Task 113 — Pre-existing schema drift: device-layer FK delete-actions never matched the datamodel

**Status: ✅ FIXED + DEPLOYED 2026-09-26.** Migration
`prisma/migrations/20261005000000_device_layer_fk_action_repair` applied to the live DB
(backed up first: `/root/db-backups/spaceworker-pre-task113-20260926093031.dump`).
Verified directly against `pg_constraint` post-apply: all 14 constraints now carry the
correct action (13 × RESTRICT, 1 × SET NULL for `DeliverabilityCheck_seedMailboxId_fkey`).
Re-ran the live drift check: only one UNRELATED, pre-existing drift line remains
(`Device_liveCaptureTokenHash_key`, from the later `task119_live_session_streaming`
migration's partial index — out of this task's scope, tracked separately). Site healthy,
all three services active post-deploy.

**Originally found:** during the B1/TASK_107 deploy, 2026-09-23, by the owner running the
live drift check after applying B1's migration.
**Severity:** real integrity gap — the DB was **cascading** deletes across the
device/audit layer where `schema.prisma` declares **RESTRICT**. Not an outage; but it
would have meant the database destroying exactly the rows RULE 5 exists to protect, had
any code path ever deleted a `Device` or `User` (verified none did — see below).

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> **Do NOT run `prisma migrate deploy`** and do not ssh the VPS. Produce the
> migration + verify it structurally (`prisma validate`, `prisma migrate diff`,
> SQL review, `tsc`). The owner applies it. The owner also owns the backup.

## The finding (verified against the live database)

`TASK_92` (`assistant_foundation`) created the shared device layer with **hand-written
SQL** (the repo convention). That SQL created the FKs — with the **same names** the
datamodel declares — but with the **wrong `ON DELETE` actions**. Nothing is missing.

Reproduce with the live DB (an in-sync database prints *"— This is an empty
migration."*):

```bash
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel  prisma/schema.prisma \
  --script
```

Current output = **14 `DROP CONSTRAINT` + 14 `ADD CONSTRAINT` (same names) + 1
`ALTER INDEX … RENAME`**. Because only the action differs, Prisma can't `ALTER` it —
it must drop and re-add. `pg_constraint.confdeltype` confirms:

| Constraint | Live DB | `schema.prisma` declares |
|---|---|---|
| `DeviceHeartbeat_deviceId_fkey` | **CASCADE** | RESTRICT |
| `DeviceCapability_deviceId_fkey` | **CASCADE** | RESTRICT |
| `DeviceJob_deviceId_fkey` / `_userId_fkey` | **CASCADE** | RESTRICT |
| `DeviceAction_deviceId_fkey` / `_userId_fkey` | **CASCADE** | RESTRICT |
| `DeviceAudit_deviceId_fkey` | **CASCADE** | RESTRICT |
| `DeviceRelationship_{sourceDeviceId,targetDeviceId,userId}_fkey` | **CASCADE** | RESTRICT |
| `DevicePowerPolicy_deviceId_fkey` | **CASCADE** | RESTRICT |
| `ActivityRollup_userId_fkey` | **CASCADE** | RESTRICT |
| `UserEntitlement_userId_fkey` | **CASCADE** | RESTRICT |
| `DeliverabilityCheck_seedMailboxId_fkey` | **RESTRICT** | **SET NULL** (reversed) |

(13 × CASCADE→RESTRICT, 1 × RESTRICT→SET NULL.)

**Why it matters:** with CASCADE, deleting a `Device` (or `User`) silently erases its
audit trail — `DeviceAudit`, `DeviceJob`, `DeviceAction`, `DeviceHeartbeat`,
`DeviceCapability`, `DeviceRelationship`, `ActivityRollup`, `UserEntitlement`. That is
precisely the failure mode RULE 5 ("an audit row must survive the thing it audited")
forbids, and the reason `CloneJob`/`AgentActionAudit` were designed with plain scalars.
Today nothing triggers it (see the safety note below) — which is why it went unnoticed.

**Also confirmed NOT part of the drift:** `CloneJob`, `RelayHealth`,
`HostedBrowserSession` and every `clone*` column — **B1/TASK_107 is cleanly in sync.**
Do not touch anything there.

## Safety note (already checked — do not re-litigate)

Switching CASCADE → RESTRICT **makes deletes stricter**, so it can only newly *fail* a
delete that previously succeeded. Verified: **no application code deletes a `Device` or
`User`** (`grep` for `device.delete` / `user.delete` / `deleteMany` across `lib/` and
`app/` → none). The change is therefore behaviourally inert today and purely corrective.

## Required reading (in this order)

1. `HOW_WE_MOVE_FAST.md` — §1–§3 (deploy + migration playbook) and **§6** ("hand-written
   SQL vs Prisma DDL", "`.next` ownership").
2. `PIPELINE_CONSOLE_BROWSER_CLONE.md` — the tracker format, and where to register this
   (it is **not** a clone-pipeline bit; log it out-of-band like C1-fu).
3. `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` — **CROSS-TRACK RULE 5** (why RESTRICT is the
   intended direction) and §SCHEMA.
4. `prisma/schema.prisma` — the `Device*`, `ActivityRollup`, `UserEntitlement`,
   `DeliverabilityCheck` models (authoritative).
5. `prisma/migrations/20260922000000_assistant_foundation/migration.sql` — the SQL that
   actually ran, so you can see the hand-written `ON DELETE CASCADE`.

## Deliverable

**One new, ADDITIVE migration** at
`prisma/migrations/<timestamp>_device_layer_fk_action_repair/migration.sql`.

**Use Prisma's own diff output verbatim** (already correct and correctly ordered):

```bash
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel  prisma/schema.prisma \
  --script > /tmp/repair.sql
```

…then paste that output into the migration file (drops → adds → the index rename, keep
the order). If you have no live DB, generate the equivalent offline:

```bash
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Rules: **never** edit an applied migration; **never** `DROP`/recreate a table or column;
no data movement; only `DROP CONSTRAINT` + `ADD CONSTRAINT` + `ALTER INDEX … RENAME`.

## Acceptance criteria

- `npx prisma validate` → valid.
- Statement census: **14 `DROP CONSTRAINT`, 14 `ADD CONSTRAINT` (identical names),
  1 `ALTER INDEX … RENAME`, and nothing else** — no `DROP TABLE`, no `DROP COLUMN`.
- Every `ADD CONSTRAINT` carries `ON UPDATE CASCADE` and the `ON DELETE` the datamodel
  declares (13 × `RESTRICT`, 1 × `SET NULL` for `DeliverabilityCheck_seedMailboxId_fkey`).
- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel
  prisma/schema.prisma` → **empty** (offline equivalent of the live test).
- `npx tsc --noEmit` clean (no code change expected).
- Report back: the census, and confirmation that each `ON DELETE` matches the datamodel.

## Owner's deploy notes

- **Back up the DB first** (`pg_dump`) even though nothing should be destroyed.
- This is a *tightening* change: after it, deleting a Device/User with device-layer rows
  will **error** instead of cascading. That is intended. If the product ever wants
  "delete my account" to also purge device history, that must be an **explicit, audited**
  purge path (RULE 5) — not a database side effect. Flag it; don't restore CASCADE.
- After apply, re-run the live drift check and expect **"— This is an empty migration."**

## Out of scope

- Any clone/`CloneJob` object (already in sync).
- Adding FKs the datamodel does not declare (that would *create* drift).
- `vantra` — this is SpaceWorker-only; the drift is in the `spaceworker` DB.

