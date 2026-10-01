-- TASK_152 M5 — user-defined screen-monitoring notifications: keyword triggers,
-- their cooldown state, and the periodic per-user digest.
--
-- Purely ADDITIVE and NULLABLE-SAFE: every new column has a default (or is
-- nullable), so applying this changes NO existing behaviour and rewrites NO row:
--   * screenTriggerNotificationsEnabled / screenDigestEnabled default FALSE —
--     the two new notification master switches start OFF for every existing
--     account (a notification feature that defaults on is how trust is lost).
--   * screenDigestIntervalMinutes defaults 120 (2 hours, the owner's example).
--   * DeviceScreenshot.triggerEvaluatedAt is NULL on every existing frame, and
--     it only records whether a frame's summary was CHECKED against triggers —
--     it never touches the capture or summary axes.
-- The consent defaults that govern capture (AdminSetting.screenshotMonitoringEnabled
-- and Device.screenshotMonitoringEnabled) are untouched.
--
-- Column order is alphabetical, matching `prisma migrate diff` output, so this
-- file stays reproducible from the datamodel.
ALTER TABLE "User"
  ADD COLUMN "screenDigestEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "screenDigestIntervalMinutes" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN "screenTriggerNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "DeviceScreenshot"
  ADD COLUMN "triggerEvaluatedAt" TIMESTAMP(3);

CREATE TABLE "ScreenTrigger" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT,
  "keyword" TEXT NOT NULL,
  "label" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 120,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScreenTrigger_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScreenTriggerState" (
  "id" TEXT NOT NULL,
  "triggerId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "lastFiredAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScreenTriggerState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScreenDigestRollup" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "deviceCount" INTEGER NOT NULL,
  "digestText" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScreenDigestRollup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ScreenTrigger_userId_idx" ON "ScreenTrigger"("userId");
CREATE INDEX "ScreenTrigger_userId_enabled_idx" ON "ScreenTrigger"("userId", "enabled");
CREATE UNIQUE INDEX "ScreenTriggerState_triggerId_deviceId_key" ON "ScreenTriggerState"("triggerId", "deviceId");
CREATE INDEX "ScreenDigestRollup_userId_windowStart_idx" ON "ScreenDigestRollup"("userId", "windowStart");
CREATE UNIQUE INDEX "ScreenDigestRollup_userId_windowStart_key" ON "ScreenDigestRollup"("userId", "windowStart");
CREATE INDEX "DeviceScreenshot_summaryDate_triggerEvaluatedAt_idx" ON "DeviceScreenshot"("summaryDate", "triggerEvaluatedAt");

ALTER TABLE "ScreenTrigger" ADD CONSTRAINT "ScreenTrigger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenTrigger" ADD CONSTRAINT "ScreenTrigger_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenTriggerState" ADD CONSTRAINT "ScreenTriggerState_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "ScreenTrigger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenTriggerState" ADD CONSTRAINT "ScreenTriggerState_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScreenDigestRollup" ADD CONSTRAINT "ScreenDigestRollup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
