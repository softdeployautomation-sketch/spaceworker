-- TASK_152 M6 — the capture scheduler: concurrency headroom, per-user fairness,
-- and rotation. Purely ADDITIVE and NULLABLE-SAFE: every new admin column has a
-- default and the new table starts empty, so applying this changes NO existing
-- behaviour and rewrites NO row.
--   * screenshotHeadroomRamPct defaults 0 = "inherit governorRamWarnPct". Out of
--     the box there is therefore still exactly ONE RAM threshold (the existing
--     warn dial), never a third hardcoded number.
--   * screenshotRotationSliceMinutes defaults 25 (the owner's 20-30 min figure).
--   * ScreenshotRotationCursor is empty on every existing account, so no user
--     rotates until their eligible devices actually exceed their granted slots.
-- The consent defaults that govern capture (AdminSetting.screenshotMonitoringEnabled
-- and Device.screenshotMonitoringEnabled) are untouched.
--
-- Generated with `prisma migrate diff` (old datamodel -> new datamodel); column
-- order is alphabetical, matching the tool's output, so this file stays
-- reproducible from the datamodel.
ALTER TABLE "AdminSetting"
  ADD COLUMN "screenshotHeadroomRamPct" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "screenshotRotationSliceMinutes" INTEGER NOT NULL DEFAULT 25;

CREATE TABLE "ScreenshotRotationCursor" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "cursorDeviceId" TEXT,
  "rotatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScreenshotRotationCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScreenshotRotationCursor_userId_key" ON "ScreenshotRotationCursor"("userId");

ALTER TABLE "ScreenshotRotationCursor" ADD CONSTRAINT "ScreenshotRotationCursor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
