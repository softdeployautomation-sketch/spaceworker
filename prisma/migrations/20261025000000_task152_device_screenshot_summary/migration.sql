-- TASK_152 M3 — per-frame summaries for device screen monitoring.
--
-- G1 (TASK_152 §3) is "no summary exists anywhere": before this, the only text
-- on a DeviceScreenshot row was failureReason, which describes the CAPTURE, not
-- the screen. This adds the summary — the owner's "summary section".
--
-- Purely ADDITIVE and NULLABLE, so applying this changes NO existing behaviour
-- and rewrites NO row: every existing frame keeps summary = NULL, which is the
-- normal "not summarised" state (not an error). Nothing on the capture path
-- reads any of these columns, so a capture can never be affected by them.
--
-- The two axes stay separate on purpose:
--   failureReason = why the CAPTURE failed (no frame on disk).
--   summaryError  = why a CAPTURED frame has no summary (cap_exhausted,
--                   ai_unavailable, ...). A captured frame with a NULL summary
--                   is NORMAL and the UI must not show it as a capture failure.
--
-- imagePurgedAt is set by the retention purge (lib/device-screenshots.ts,
-- purgeExpiredFrames) when the RAW image is deleted but the SUMMARY is kept:
-- the owner's decision is that the text outlives the pixels, so a summary row
-- is MARKED as image-expired rather than destroyed with its file.
--
-- Column order is alphabetical, matching `prisma migrate diff` output, so this
-- file stays reproducible from the datamodel.
ALTER TABLE "DeviceScreenshot"
  ADD COLUMN "imagePurgedAt" TIMESTAMP(3),
  ADD COLUMN "summarisedAt" TIMESTAMP(3),
  ADD COLUMN "summary" TEXT,
  ADD COLUMN "summaryError" TEXT,
  ADD COLUMN "summaryModel" TEXT;
