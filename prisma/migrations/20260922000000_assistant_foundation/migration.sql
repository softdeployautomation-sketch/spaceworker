-- Task 92 — Assistant foundation (device layer + entitlements core).
-- Plan: PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md §SCHEMA + §CROSS-TRACK RULES.
-- Creates the SHARED device layer every device-side feature must consume
-- (Vantra plugin, Browser Clone, Cyber Lab — no private copies of identity,
-- approval, audit, or panic primitives) plus the UserEntitlement gate and
-- the AgentActionAudit product audit. pendingActionId/cloneId are plain
-- scalars (no FK) so audits survive deletion of the audited object.
-- Also: User.digestEnabled / User.deviceTelemetryEnabled master toggles.

ALTER TABLE "User" ADD COLUMN "digestEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "deviceTelemetryEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deviceKind" TEXT NOT NULL DEFAULT 'workstation',
    "vantraAgentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "osName" TEXT,
    "osVersion" TEXT,
    "hardwareSummary" JSONB,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceHeartbeat" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "agentVersion" TEXT,
    "ipAddress" TEXT,
    "telemetry" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceCapability" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceCapability_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "pendingActionId" TEXT,
    "actionType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceAction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceAudit" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "channel" TEXT,
    "event" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeviceRelationship" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceDeviceId" TEXT NOT NULL,
    "targetDeviceId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRelationship_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DevicePowerPolicy" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'off',
    "until" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevicePowerPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityRollup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rollupDate" TIMESTAMP(3) NOT NULL,
    "digestText" TEXT NOT NULL,
    "agentThreadId" TEXT,
    "aiCostHundredthsCent" INTEGER NOT NULL DEFAULT 0,
    "deliveredChannels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityRollup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserEntitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'module',
    "expiresAt" TIMESTAMP(3),
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentActionAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "pendingActionId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "initiatingChannel" TEXT NOT NULL DEFAULT 'web',
    "approvalChannel" TEXT,
    "sourceDeviceId" TEXT,
    "destinationDeviceId" TEXT,
    "cloneId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentActionAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Device_vantraAgentId_key" ON "Device"("vantraAgentId");
CREATE UNIQUE INDEX "DeviceCapability_deviceId_capability_key" ON "DeviceCapability"("deviceId", "capability");
CREATE UNIQUE INDEX "DeviceRelationship_sourceDeviceId_targetDeviceId_relationType_key" ON "DeviceRelationship"("sourceDeviceId", "targetDeviceId", "relationType");
CREATE UNIQUE INDEX "DevicePowerPolicy_deviceId_key" ON "DevicePowerPolicy"("deviceId");
CREATE UNIQUE INDEX "ActivityRollup_userId_rollupDate_key" ON "ActivityRollup"("userId", "rollupDate");
CREATE UNIQUE INDEX "UserEntitlement_userId_key_key" ON "UserEntitlement"("userId", "key");

CREATE INDEX "Device_userId_idx" ON "Device"("userId");
CREATE INDEX "Device_userId_status_idx" ON "Device"("userId", "status");
CREATE INDEX "DeviceHeartbeat_deviceId_createdAt_idx" ON "DeviceHeartbeat"("deviceId", "createdAt");
CREATE INDEX "DeviceCapability_deviceId_idx" ON "DeviceCapability"("deviceId");
CREATE INDEX "DeviceJob_userId_idx" ON "DeviceJob"("userId");
CREATE INDEX "DeviceJob_deviceId_status_idx" ON "DeviceJob"("deviceId", "status");
CREATE INDEX "DeviceAction_userId_idx" ON "DeviceAction"("userId");
CREATE INDEX "DeviceAction_deviceId_status_idx" ON "DeviceAction"("deviceId", "status");
CREATE INDEX "DeviceAction_pendingActionId_idx" ON "DeviceAction"("pendingActionId");
CREATE INDEX "DeviceAudit_deviceId_createdAt_idx" ON "DeviceAudit"("deviceId", "createdAt");
CREATE INDEX "DeviceRelationship_userId_idx" ON "DeviceRelationship"("userId");
CREATE INDEX "ActivityRollup_userId_rollupDate_idx" ON "ActivityRollup"("userId", "rollupDate");
CREATE INDEX "UserEntitlement_userId_idx" ON "UserEntitlement"("userId");
CREATE INDEX "AgentActionAudit_userId_createdAt_idx" ON "AgentActionAudit"("userId", "createdAt");
CREATE INDEX "AgentActionAudit_pendingActionId_idx" ON "AgentActionAudit"("pendingActionId");

-- Foreign keys. Owner tables cascade with their user; AgentActionAudit.userId
-- is SetNull on purpose (a product audit must survive even user deletion).
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeviceHeartbeat" ADD CONSTRAINT "DeviceHeartbeat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceCapability" ADD CONSTRAINT "DeviceCapability_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceJob" ADD CONSTRAINT "DeviceJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceJob" ADD CONSTRAINT "DeviceJob_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceAction" ADD CONSTRAINT "DeviceAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceAction" ADD CONSTRAINT "DeviceAction_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceAudit" ADD CONSTRAINT "DeviceAudit_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceRelationship" ADD CONSTRAINT "DeviceRelationship_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceRelationship" ADD CONSTRAINT "DeviceRelationship_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceRelationship" ADD CONSTRAINT "DeviceRelationship_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevicePowerPolicy" ADD CONSTRAINT "DevicePowerPolicy_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ActivityRollup" ADD CONSTRAINT "ActivityRollup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserEntitlement" ADD CONSTRAINT "UserEntitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentActionAudit" ADD CONSTRAINT "AgentActionAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;