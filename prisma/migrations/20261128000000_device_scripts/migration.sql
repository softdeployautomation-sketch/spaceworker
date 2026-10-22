-- 2026-10-22 — saved device scripts, their runs, and "run after public
-- enrollment" rules.
--
-- CREATE-ONLY: three new tables, nothing existing is altered. The relation
-- fields added to User/Device in schema.prisma are Prisma-level only (no
-- columns, no FK from those tables to these).

-- CreateTable
CREATE TABLE "DeviceScript" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "shell" TEXT NOT NULL DEFAULT 'powershell',
    "body" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 90,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceScript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceScriptAutoRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "targetTier" TEXT NOT NULL DEFAULT 'public',
    "delayMinutes" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceScriptAutoRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceScriptRun" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "scheduledFor" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "output" TEXT,
    "error" TEXT,
    "autoRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceScriptRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceScript_userId_archivedAt_idx" ON "DeviceScript"("userId", "archivedAt");

-- CreateIndex
CREATE INDEX "DeviceScriptAutoRule_userId_enabled_idx" ON "DeviceScriptAutoRule"("userId", "enabled");

-- CreateIndex
CREATE INDEX "DeviceScriptRun_userId_createdAt_idx" ON "DeviceScriptRun"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceScriptRun_status_scheduledFor_idx" ON "DeviceScriptRun"("status", "scheduledFor");

-- CreateIndex (idempotent auto-enroll: one fire per rule per device)
CREATE UNIQUE INDEX "DeviceScriptRun_autoRuleId_deviceId_key" ON "DeviceScriptRun"("autoRuleId", "deviceId");

-- AddForeignKey
ALTER TABLE "DeviceScript" ADD CONSTRAINT "DeviceScript_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceScriptAutoRule" ADD CONSTRAINT "DeviceScriptAutoRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceScriptAutoRule" ADD CONSTRAINT "DeviceScriptAutoRule_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "DeviceScript"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceScriptRun" ADD CONSTRAINT "DeviceScriptRun_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "DeviceScript"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceScriptRun" ADD CONSTRAINT "DeviceScriptRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceScriptRun" ADD CONSTRAINT "DeviceScriptRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceScriptRun" ADD CONSTRAINT "DeviceScriptRun_autoRuleId_fkey" FOREIGN KEY ("autoRuleId") REFERENCES "DeviceScriptAutoRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
