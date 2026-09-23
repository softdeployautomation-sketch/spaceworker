-- Task 97/107 — Browser Clone pipeline (deliverable 1). NEVER APPLIED anywhere;
-- rewritten in place by Task 107 (B1) after a structural audit. Verified
-- statement-for-statement against Prisma's own expected DDL:
--   npx prisma migrate diff --from-schema-datamodel <pre-clone schema> \
--     --to-schema-datamodel prisma/schema.prisma --script
--
-- Three tables, all built on the SHARED device layer (Michael's directive: the
-- clone is a device capability, not a parallel subsystem) — so there is no new
-- approval table, no new audit table and no new transport here:
--   Approval -> AgentPendingAction (via CloneJob.pendingActionId)
--   Audit    -> AgentActionAudit (action 'browser-clone'; the sourceDeviceId /
--               destinationDeviceId / cloneId columns already exist from Task 92)
--   Devices  -> Device (sourceDeviceId and destinationDeviceId both reference it)
--   Lifecycle/panic -> CloneJob.status, wired into lib/devices.ts panicStopAllDevices
--
-- Task 107 audit fixes to this (unapplied) file:
--   * AdminSetting key names now match the TASK_107 spec exactly:
--     cloneMaxConcurrent (was cloneSessionsMaxConcurrent), clonePerUserCap (was
--     clonePerUserMax), cloneHardTtlMinutes=480 (was cloneHardTtlHours=8), plus
--     the missing cloneRelayRequired=true. The old names only ever existed in
--     this file + git history — no database has them.
--   * CloneJob.cloneId added: the engine-side registry id, stamped into
--     AgentActionAudit so the record and the engine's own audit correlate.
--   * Expiry-sweep indexes added: (status, idleExpiresAt) and (status, expiresAt).
--
-- RelayHealth doubles as the relay registry AND its current health: one row per
-- source device, health fields updated in place (mirrors Device.status /
-- lastSeenAt). Only the SHA-256 of the relay token is stored.
--
-- CloneJob records are kept for audit; only the STAGING MATERIAL (the encrypted
-- capture, CloneJob.stagingRef) is deleted on revoke/expiry, and inactive records
-- are purged after AdminSetting.clonePurgeAfterDays (30).
--
-- FK policy (plan RULE 5 — an audit row must survive the thing it audited):
--   * pendingActionId + cloneId are PLAIN SCALARS with NO foreign key on purpose.
--   * userId/sourceDeviceId are RESTRICT: a clone record pins its actors, so a
--     user/device delete cannot silently erase clone history.
--   * destinationDeviceId / relayId / HostedBrowserSession.cloneJobId are
--     SET NULL: they describe the disposable side (a re-provisioned pool host, a
--     replaced relay) and must never block a cleanup.
-- Every camelCase column is quoted; enums are TEXT with documented value lists.

-- AdminSetting — Browser Clone limits (CROSS-TRACK RULE 7: nothing hardwired).
-- Defaults match the schema/code defaults exactly, so this is purely additive:
-- zero behaviour change until an admin touches a value. cloneIdleTtlMinutes /
-- cloneHardTtlMinutes are Q1's proposed numbers (60 min idle / 480 min = 8 h
-- hard cap); they are stamped onto each CloneJob at creation, so a later change
-- here never retroactively expires a running session.
ALTER TABLE "AdminSetting" ADD COLUMN "cloneSessionsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminSetting" ADD COLUMN "cloneMaxConcurrent" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "AdminSetting" ADD COLUMN "clonePerUserCap" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdminSetting" ADD COLUMN "hostedPoolSize" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdminSetting" ADD COLUMN "cloneIdleTtlMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "AdminSetting" ADD COLUMN "cloneHardTtlMinutes" INTEGER NOT NULL DEFAULT 480;
ALTER TABLE "AdminSetting" ADD COLUMN "clonePurgeAfterDays" INTEGER NOT NULL DEFAULT 30;
-- Direct egress (`--proxy-optional`) is PREMIUM ONLY (owner 2026-10-01).
ALTER TABLE "AdminSetting" ADD COLUMN "cloneDirectEgressPremiumOnly" BOOLEAN NOT NULL DEFAULT true;
-- Relay mode fails closed when the relay is down (owner contract, DESIGN §4).
ALTER TABLE "AdminSetting" ADD COLUMN "cloneRelayRequired" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "RelayHealth" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "addr" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastSeenAt" TIMESTAMP(3),
    "lastCheckAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelayHealth_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RelayHealth_deviceId_key" ON "RelayHealth"("deviceId");
CREATE INDEX "RelayHealth_userId_status_idx" ON "RelayHealth"("userId", "status");

ALTER TABLE "RelayHealth" ADD CONSTRAINT "RelayHealth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RelayHealth" ADD CONSTRAINT "RelayHealth_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE TABLE "CloneJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceDeviceId" TEXT NOT NULL,
    "destinationDeviceId" TEXT,
    "relayId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "launchState" TEXT NOT NULL DEFAULT 'not_launched',
    "pendingActionId" TEXT,
    "cloneId" TEXT,
    "egressMode" TEXT NOT NULL DEFAULT 'relay',
    "browser" TEXT NOT NULL,
    "profileName" TEXT,
    "stagingRef" TEXT,
    "archiveBytes" INTEGER,
    "fileCount" INTEGER,
    "captureExitCode" INTEGER,
    "error" TEXT,
    "idleExpiresAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "purgeAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloneJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CloneJob_userId_createdAt_idx" ON "CloneJob"("userId", "createdAt");
CREATE INDEX "CloneJob_sourceDeviceId_status_idx" ON "CloneJob"("sourceDeviceId", "status");
CREATE INDEX "CloneJob_destinationDeviceId_status_idx" ON "CloneJob"("destinationDeviceId", "status");
-- TASK_112's TTL sweeps: (status, idleExpiresAt) for the idle teardown,
-- (status, expiresAt) for the hard cap. purgeAfter below is the purge sweep.
CREATE INDEX "CloneJob_status_idleExpiresAt_idx" ON "CloneJob"("status", "idleExpiresAt");
CREATE INDEX "CloneJob_status_expiresAt_idx" ON "CloneJob"("status", "expiresAt");
CREATE INDEX "CloneJob_status_purgeAfter_idx" ON "CloneJob"("status", "purgeAfter");

ALTER TABLE "CloneJob" ADD CONSTRAINT "CloneJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CloneJob" ADD CONSTRAINT "CloneJob_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "HostedBrowserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "cloneJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "cdpPort" INTEGER,
    "viewUrl" TEXT,
    "egressIp" TEXT,
    "egressMode" TEXT NOT NULL DEFAULT 'relay',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostedBrowserSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HostedBrowserSession_cloneJobId_key" ON "HostedBrowserSession"("cloneJobId");
CREATE INDEX "HostedBrowserSession_userId_status_idx" ON "HostedBrowserSession"("userId", "status");
CREATE INDEX "HostedBrowserSession_deviceId_status_idx" ON "HostedBrowserSession"("deviceId", "status");

ALTER TABLE "HostedBrowserSession" ADD CONSTRAINT "HostedBrowserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HostedBrowserSession" ADD CONSTRAINT "HostedBrowserSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HostedBrowserSession" ADD CONSTRAINT "HostedBrowserSession_cloneJobId_fkey" FOREIGN KEY ("cloneJobId") REFERENCES "CloneJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CloneJob" ADD CONSTRAINT "CloneJob_destinationDeviceId_fkey" FOREIGN KEY ("destinationDeviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CloneJob" ADD CONSTRAINT "CloneJob_relayId_fkey" FOREIGN KEY ("relayId") REFERENCES "RelayHealth"("id") ON DELETE SET NULL ON UPDATE CASCADE;
