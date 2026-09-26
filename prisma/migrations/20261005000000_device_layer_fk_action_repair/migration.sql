-- Task 113 — repairs pre-existing schema drift, found 2026-09-23 during the
-- B1/TASK_107 deploy's post-migration drift check (HOW_WE_MOVE_FAST.md §6b).
--
-- TASK_92's hand-written migration (20260922000000_assistant_foundation)
-- created these FKs with the SAME NAMES the datamodel declares, but with the
-- WRONG `ON DELETE` action: 13 came in as CASCADE where the schema declares
-- RESTRICT, and one (DeliverabilityCheck_seedMailboxId_fkey) came in as
-- RESTRICT where the schema declares SET NULL. Nothing is missing or extra —
-- only the delete-action differs, which is why Prisma can't ALTER it and
-- must drop + re-add.
--
-- Why it matters (CROSS-TRACK RULE 5 — "an audit row must survive the thing
-- it audited"): with CASCADE, deleting a Device or User silently erased its
-- entire audit trail (DeviceAudit, DeviceJob, DeviceAction, DeviceHeartbeat,
-- DeviceCapability, DeviceRelationship, ActivityRollup, UserEntitlement).
--
-- Safety (verified, not assumed): switching CASCADE -> RESTRICT only makes
-- deletes STRICTER, so it can only newly fail a delete that previously
-- succeeded. No application code anywhere deletes a Device or User row
-- (grepped lib/ and app/ for device.delete / user.delete / deleteMany
-- against those models) — this migration is behaviourally inert today and
-- purely corrective.
--
-- This file is Prisma's own `migrate diff` output, verbatim (see the task
-- doc, TASK_113_SCHEMA_DRIFT_DEVICE_LAYER_FKS.md, for the exact reproduction
-- command) — only drops, re-adds with the correct action, and the one index
-- rename that comes along with DeviceRelationship's constraint names
-- shortening. No table/column touched, no data moved.
--
-- A separate, UNRELATED drift item (a stray `CREATE UNIQUE INDEX
-- Device_liveCaptureTokenHash_key` from the later 20260925000000
-- task119_live_session_streaming migration, which used a partial index —
-- `WHERE "liveCaptureTokenHash" IS NOT NULL` — that Prisma's diff doesn't
-- recognize as equivalent to a plain unique index of the same name) was
-- DELIBERATELY excluded from this migration — out of scope per this task's
-- own rules ("adding FKs/indexes the datamodel does not declare" and "only
-- DROP CONSTRAINT + ADD CONSTRAINT + ALTER INDEX ... RENAME"). Tracked and
-- repaired separately.

-- DropForeignKey
ALTER TABLE "ActivityRollup" DROP CONSTRAINT "ActivityRollup_userId_fkey";

-- DropForeignKey
ALTER TABLE "DeliverabilityCheck" DROP CONSTRAINT "DeliverabilityCheck_seedMailboxId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceAction" DROP CONSTRAINT "DeviceAction_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceAction" DROP CONSTRAINT "DeviceAction_userId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceAudit" DROP CONSTRAINT "DeviceAudit_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceCapability" DROP CONSTRAINT "DeviceCapability_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceHeartbeat" DROP CONSTRAINT "DeviceHeartbeat_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceJob" DROP CONSTRAINT "DeviceJob_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceJob" DROP CONSTRAINT "DeviceJob_userId_fkey";

-- DropForeignKey
ALTER TABLE "DevicePowerPolicy" DROP CONSTRAINT "DevicePowerPolicy_deviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceRelationship" DROP CONSTRAINT "DeviceRelationship_sourceDeviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceRelationship" DROP CONSTRAINT "DeviceRelationship_targetDeviceId_fkey";

-- DropForeignKey
ALTER TABLE "DeviceRelationship" DROP CONSTRAINT "DeviceRelationship_userId_fkey";

-- DropForeignKey
ALTER TABLE "UserEntitlement" DROP CONSTRAINT "UserEntitlement_userId_fkey";

-- AddForeignKey
ALTER TABLE "DeliverabilityCheck" ADD CONSTRAINT "DeliverabilityCheck_seedMailboxId_fkey" FOREIGN KEY ("seedMailboxId") REFERENCES "SeedMailbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceHeartbeat" ADD CONSTRAINT "DeviceHeartbeat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCapability" ADD CONSTRAINT "DeviceCapability_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceJob" ADD CONSTRAINT "DeviceJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceJob" ADD CONSTRAINT "DeviceJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAction" ADD CONSTRAINT "DeviceAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAction" ADD CONSTRAINT "DeviceAction_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceAudit" ADD CONSTRAINT "DeviceAudit_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRelationship" ADD CONSTRAINT "DeviceRelationship_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRelationship" ADD CONSTRAINT "DeviceRelationship_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRelationship" ADD CONSTRAINT "DeviceRelationship_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePowerPolicy" ADD CONSTRAINT "DevicePowerPolicy_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRollup" ADD CONSTRAINT "ActivityRollup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "DeviceRelationship_sourceDeviceId_targetDeviceId_relationType_k" RENAME TO "DeviceRelationship_sourceDeviceId_targetDeviceId_relationTy_key";
