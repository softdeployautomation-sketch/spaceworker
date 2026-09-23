# Task 107 (bit B1) — Browser Clone schema + admin caps (finish the paused WIP)

**Status: WIP PAUSED — schema + migration committed as `b827170` but the migration
has NEVER been applied and the admin caps/settings are missing.**
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
  lifecycle, launch state, `browserProfileRef`, `pendingActionId`, `cloneId`,
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
