-- TASK_127 Phase 1 — device screenshot monitoring (automated CAPTURE only).
--
-- Phase 2 (the end-of-day AI summary) deliberately has NO tables here: it is a
-- separate, later change, so this migration stays exactly as big as what shipped.
--
-- Everything below is additive with a default, so applying this migration
-- changes NO existing behaviour. The master switch and every per-device opt-in
-- land FALSE, which means nothing is ever captured until BOTH an admin turns the
-- master switch on AND a device's owner opts that specific device in.
--
-- The frame BYTES are not stored here by design — a row holds a relative path
-- under the screenshot root. See DeviceScreenshot's doc comment in schema.prisma
-- for why (and for why the row doubles as the governor's concurrency slot).

-- The four admin dials. screenshotCapturesMaxConcurrent is also the governor's
-- cap column for the new `deviceScreenshots` feature (TASK_105's registry), so
-- it is the single place the "how many captures at once" number lives.
ALTER TABLE "AdminSetting"
  ADD COLUMN "screenshotMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "screenshotCapturesMaxConcurrent" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "screenshotCaptureIntervalMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "screenshotRetentionDays" INTEGER NOT NULL DEFAULT 14;

-- The per-device opt-in — the consent boundary the task doc makes
-- non-negotiable. Default false: no device is captured until its owner says so.
ALTER TABLE "Device"
  ADD COLUMN "screenshotMonitoringEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "DeviceScreenshot" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  -- "capturing" | "captured" | "failed" (TEXT + documented, the codebase style).
  "status" TEXT NOT NULL DEFAULT 'capturing',
  "filePath" TEXT,
  "bytes" INTEGER,
  "width" INTEGER,
  "height" INTEGER,
  "failureReason" TEXT,
  "summaryDate" TIMESTAMP(3) NOT NULL,
  "capturedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DeviceScreenshot_pkey" PRIMARY KEY ("id")
);

-- Read paths that actually exist (TASK_107 discipline — index what is queried):
--   the governor's live count    -> status ("capturing")
--   a device's frames for a day  -> deviceId + summaryDate + status
--   the retention purge          -> summaryDate + status
--   a user's recent frames       -> userId + createdAt
CREATE INDEX "DeviceScreenshot_status_idx" ON "DeviceScreenshot"("status");
CREATE INDEX "DeviceScreenshot_deviceId_summaryDate_status_idx"
  ON "DeviceScreenshot"("deviceId", "summaryDate", "status");
CREATE INDEX "DeviceScreenshot_userId_createdAt_idx"
  ON "DeviceScreenshot"("userId", "createdAt");
CREATE INDEX "DeviceScreenshot_summaryDate_status_idx"
  ON "DeviceScreenshot"("summaryDate", "status");

-- Cascade, matching GovernorQueueEntry's reasoning: a frame of a deleted
-- account's screen has nothing to preserve. (The FILE is deleted by the
-- retention sweep; this FK is what removes the row.)
ALTER TABLE "DeviceScreenshot"
  ADD CONSTRAINT "DeviceScreenshot_deviceId_fkey" FOREIGN KEY ("deviceId")
  REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceScreenshot"
  ADD CONSTRAINT "DeviceScreenshot_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
