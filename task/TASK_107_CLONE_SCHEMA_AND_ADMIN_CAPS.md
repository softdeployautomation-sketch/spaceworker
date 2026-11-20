# Task 107 (bit B1) — Browser Clone schema + admin caps (finish the paused WIP)

**Status: DONE · DEPLOYED · VERIFIED 2026-09-23** — migration applied, admin caps
live. Commits: branch `agent/task-107-clone-schema` `399a804`, merged to `main` as
`7f27457`. (Superseded the paused `b827170`; the migration was rewritten in place
because it had never been applied anywhere.)
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B1** — first clone bit).
**Plan:** `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2, §SCHEMA, §CROSS-TRACK RULES 5/6/7.

> ## AGENT CONTRACT — COMMIT ONLY, DO NOT DEPLOY
> **Do NOT run `prisma migrate deploy`** and do not ssh the VPS. You verify the
> migration *structurally* (`prisma validate`, `prisma migrate diff`, SQL review).
> The owner applies it on the server. Full rules:
> `PIPELINE_CONSOLE_BROWSER_CLONE.md` §STANDARD AGENT CONTRACT.

## Read first (mandatory)

- **`HOW_WE_MOVE_FAST.md`** §0–§3 and **§6** (migration gotchas: hand-written SQL,
  `ARRAY[]::TEXT[]`, quoted camelCase columns, the `--files-from` + `-r` trap).
- **`TASK_97_BROWSER_CLONE.md`** — deliverable 1 + the full pipeline contract.
- **`DESIGN_BROWSER_CLONE_UI_AND_FLOW.md`** — lifecycle states the schema must carry
  (job → captured → transferred → launched → active → expired/revoked), the three
  launch modes, and the per-clone record/history requirement.
- **Michael's directive** in `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §PRIORITY P2:
  the clone is a **device capability**, never a parallel subsystem — reuse
  `Device` / `AgentPendingAction` / `AgentActionAudit` / panic; invent nothing.
- **`TASK_92_...`** for `Device`/`DeviceJob`/`DeviceCapability`/`AgentActionAudit`.
- **`app/api/admin/admission-control/route.ts`** + `lib/admin-settings.ts` — the
  existing admin-limits pattern (enabled + max + live counts) to mirror.

## What already exists (from `b827170`)

`prisma/schema.prisma` gained the clone models and
`prisma/migrations/20261002000000_browser_clone_pipeline/migration.sql` was written
by hand. **Read both before changing anything.** The migration header documents the
intended contract:

- `RelayHealth` — doubles as relay registry **and** health (one row per source
  device, unique `deviceId`, only the **SHA-256** of the relay token stored).
- `CloneJob` — `userId`, `sourceDeviceId`, `destinationDeviceId`, `relayId`,
  lifecycle, launch state, `profileName`, `pendingActionId`, `cloneId`,
  `stagingRef`, TTL/expiry timestamps.
- `HostedBrowserSession` — the hosted-side session record.
- Records are **kept**; only **staging material** is deleted on revoke/expiry.
- `AdminSetting.clonePurgeAfterDays` (default **30**).

## Deliverables

1. **Audit the committed migration for correctness** and fix in place (same file,
   it has never been applied anywhere). Check specifically:
   - every `camelCase` column is quoted in SQL;
   - `TEXT` (not `VARCHAR`), `TIMESTAMP(3)`, `DEFAULT CURRENT_TIMESTAMP` defaults;
   - FK `ON DELETE` choices are deliberate — **audit rows must survive** the thing
     they audited (plan RULE 5), so `CloneJob.pendingActionId` / `cloneId` stay
     FK-less scalars;
   - indexes exist for the read paths the UI needs (`userId` + status/createdAt,
     `sourceDeviceId`, `destinationDeviceId`, expiry sweep);
   - enums are plain `TEXT` with a documented value list (the codebase's style).
2. **The complete `AdminSetting` cap/TTL set** — no hardwired limits anywhere
   (CROSS-TRACK RULE 7). Add/verify all of these with the documented defaults:
   | Setting | Default | Meaning |
   |---|---|---|
   | `cloneMaxConcurrent` | `2` | engine-wide concurrent clone sessions |
   | `clonePerUserCap` | `1` | concurrent clones per user |
   | `hostedPoolSize` | `1` | pooled hosted PCs available |
   | `cloneIdleTtlMinutes` | `60` | idle TTL before a session is torn down |
   | `cloneHardTtlMinutes` | `480` | absolute session ceiling (8 h) |
   | `clonePurgeAfterDays` | `30` | inactive record purge window |
   | `cloneDirectEgressPremiumOnly` | `true` | direct-egress is premium-only (owner decision) |
   | `cloneRelayRequired` | `true` | relay mode fails closed when the relay is down |
3. **Admin panel surface** in `app/admin/(protected)/admin-panel.tsx`: a *Browser
   clone limits* block mirroring admission-control's UI (enabled + limits + **live
   counts**), so the owner can see/change these without a deploy.
4. **Wire the settings readers** (no consumers yet — that's `TASK_109/110`): export
   a small typed accessor (e.g. `lib/clone-settings.ts`) so later bits never read
   `AdminSetting` strings directly.

## Out of scope

- Orchestration, routes, UI (`TASK_108`–`TASK_112`).
- Applying the migration (owner).
- The resource governor itself (`TASK_105`).

## Acceptance (owner runs after deploy)

- `npx prisma validate` → OK.
- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` → **0** (schema ⇄ migrations in sync).
- `npx prisma generate` succeeds and `npx tsc --noEmit` is clean.
- Reviewer can name, for each new table, which shared primitive it reuses
  (Device / AgentPendingAction / AgentActionAudit / panic) — **no new approval or
  audit framework exists in the diff.**
- After the owner applies it: `\dt` shows the tables, `\d "CloneJob"` shows the
  indexes, and the admin panel renders the new limits with live counts.

## Report back

Exact files changed · validator/diff/tsc output · the AdminSetting keys added ·
any SQL you were unsure about (call it out rather than guessing).
## Owner deploy + verification (2026-09-23) — DONE

Deployed to the VPS exactly per `HOW_WE_MOVE_FAST.md` §1–§3 (`.env` never touched):

1. `.env` snapshot + **DB backup first** → `/root/spaceworker-db.bak-t107.sql` (54 MB).
2. rsync `--exclude='.env'` of `prisma/schema.prisma`, the migration, `lib/clone-settings.ts`,
   `app/api/admin/clone-limits/route.ts`, `app/admin/(protected)/admin-panel.tsx`.
3. `prisma migrate deploy` → *"All migrations have been successfully applied"*
   (`20261002000000_browser_clone_pipeline`).
4. `prisma generate` → client carries the new models (433 refs).
5. Build as `trmm` (`Compiled successfully`, 0 errors) → `systemctl restart spaceworker`.

**Verified live:**

| Check | Result |
|---|---|
| `prisma migrate status` | **Database schema is up to date!** |
| **DB ⇄ schema drift, filtered to the clone objects** | **none** (see finding below) |
| Tables exist | `CloneJob`, `RelayHealth`, `HostedBrowserSession` ✓ |
| Indexes (14) incl. both new sweep indexes | `CloneJob_status_idleExpiresAt_idx`, `CloneJob_status_expiresAt_idx` ✓ |
| 9 `AdminSetting` clone columns + defaults | all present, defaults match `CLONE_SETTING_DEFAULTS` exactly ✓ |
| `GET /api/admin/clone-limits` unauth | **403** (not 404 — route live, gate holds) |
| `GET` with a real admin session | full payload: `limits` 2/1/1/60/480/30 + `policy` + `live` counts ✓ |
| `PATCH {"maxConcurrent":3}` | 200, **persisted** (DB readback `3`), then restored to `2` ✓ |
| `PATCH 0` / unknown key / non-int | **400** each, with a specific message ✓ |
| `/admin` page, authed | **200**, and the *Browser clones* block is in the built panel chunk ✓ |
| `spaceworker.top` | **200**, service `active` |

**Acceptance #2 (the one the agent couldn't run locally — no shadow DB) is now
satisfied** via `migrate diff --from-schema-datasource … --to-schema-datamodel` against
the live database, filtered to the clone objects: **zero drift**.

### ⚠️ Finding (pre-existing, NOT caused by B1) → `TASK_113_SCHEMA_DRIFT_DEVICE_LAYER_FKS.md`

The same live drift check surfaced **87 lines of pre-existing drift from Task 92**
(`assistant_foundation`). The mechanism, after reading `pg_constraint` directly: the
device-layer FKs **exist with the same names** but the hand-written SQL gave them the
**wrong delete actions** — **13 are `ON DELETE CASCADE` in the live DB where
`schema.prisma` declares `RESTRICT`** (`DeviceHeartbeat`, `DeviceCapability`, `DeviceJob`,
`DeviceAction`, `DeviceAudit`, `DeviceRelationship` ×3, `DevicePowerPolicy`,
`ActivityRollup`, `UserEntitlement`), **1 is reversed** (`DeliverabilityCheck_seedMailboxId_fkey`
is RESTRICT in the DB but SET NULL in the datamodel), plus one index-name drift
(`…relationType_k` → `…relationTy_key`). Prisma expresses the action change as
`DROP CONSTRAINT` + `ADD CONSTRAINT` on the same name, which is why the diff looks like a
re-add.

**Impact:** with CASCADE, deleting a `Device`/`User` silently erases its device/audit
rows — the exact failure RULE 5 forbids. **Verified to contain zero clone-table
references**, so B1 is cleanly in sync and must not be touched. Behaviourally inert today
(no app code deletes a `Device`/`User`), so it is a *tightening* fix, tracked separately
because it needs its own migration + backup rather than a ride-along on this deploy.
