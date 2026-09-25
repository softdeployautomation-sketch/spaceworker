-- Task 119A — Live Session Streaming for Hosted Clones
--
-- TASK_119: adds a second clone mode (live) that captures the user's live
-- session via CDP and streams it to the hosted clone, enabling agents to
-- access logged-in accounts even when the user's device is offline. Existing
-- "fresh" clones (route 3) are unchanged — this is fully additive, defaulting
-- to "fresh" behaviour for backward compatibility.
--
-- Schema changes:
-- 1. CloneJob.sessionMode: "fresh" (default, unchanged) | "live" (new)
-- 2. HostedBrowserSession: capture metadata (counts only, never values, short TTL)
--
-- FK policy (TASK_119 A5/A6):
--   * No new foreign keys — sessionMode is a plain scalar like pendingActionId.
--   * Capture payloads are held in memory or with 0600 permissions, deleted after
--     use or job teardown — structured to never persist cookie values to disk.

-- 1. Add sessionMode to CloneJob (additive, backward-compatible default).
ALTER TABLE "CloneJob" ADD COLUMN "sessionMode" TEXT NOT NULL DEFAULT 'fresh';

-- 2. Add session capture credential to Device (token hash only, never raw token).
ALTER TABLE "Device" ADD COLUMN "liveCaptureTokenHash" TEXT;
CREATE UNIQUE INDEX "Device_liveCaptureTokenHash_key" ON "Device"("liveCaptureTokenHash") WHERE "liveCaptureTokenHash" IS NOT NULL;

-- 3. Add session capture fields to HostedBrowserSession (NEVER stores values).
ALTER TABLE "HostedBrowserSession" ADD COLUMN "sessionMode" TEXT;
ALTER TABLE "HostedBrowserSession" ADD COLUMN "cookieCount" INTEGER;
ALTER TABLE "HostedBrowserSession" ADD COLUMN "domainCount" INTEGER;
ALTER TABLE "HostedBrowserSession" ADD COLUMN "sessionTruncated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "HostedBrowserSession" ADD COLUMN "capturedAt" TIMESTAMP(3);
