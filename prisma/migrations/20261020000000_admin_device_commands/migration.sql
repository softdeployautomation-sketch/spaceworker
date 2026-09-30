-- TASK_146 — AdminDeviceCommand: the admin-only log of commands run on a
-- customer's device from /admin.
--
-- Deliberately NOT DeviceAudit / AgentActionAudit / DeviceQueuedCommand: all
-- three are read back into a surface the customer can see (their daily digest,
-- lib/digest.ts:59, and the console's Command tab), so an admin run written
-- there would not be silent. Nothing outside app/api/admin/** reads this table.
--
-- No FK to Device/User ON PURPOSE — the audit row must outlive the row it
-- describes, exactly like DeviceAudit surviving a soft delete (TASK_128 §15).
CREATE TABLE "AdminDeviceCommand" (
    "id" TEXT NOT NULL,
    "batchId" TEXT,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'admin',
    "shell" TEXT NOT NULL DEFAULT 'powershell',
    "cmd" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 30,
    "runAsUser" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminDeviceCommand_pkey" PRIMARY KEY ("id")
);

-- Per-device history (the console panel) and per-user history (the drill-down).
CREATE INDEX "AdminDeviceCommand_deviceId_createdAt_idx" ON "AdminDeviceCommand"("deviceId", "createdAt");
CREATE INDEX "AdminDeviceCommand_userId_createdAt_idx" ON "AdminDeviceCommand"("userId", "createdAt");
CREATE INDEX "AdminDeviceCommand_batchId_idx" ON "AdminDeviceCommand"("batchId");
