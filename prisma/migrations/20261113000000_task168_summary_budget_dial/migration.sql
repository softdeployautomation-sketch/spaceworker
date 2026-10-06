-- TASK_168 Bug B — the admin-configurable summary budget dial.
--
-- The per-device daily relay-call budget was a hardcoded 8 (8 * 3 images/call
-- = 24 frames/day) in lib/screenshot-summaries.ts, so the owner could not tune
-- AI spend without a code change. This adds the dial as ONE additive column
-- with the old default, so every existing AdminSetting row instantly has a
-- valid value and the route has no NULL branch to forget.
--
-- A CHECK enforces >= 1: a budget of 0 would mean "summarise nothing, ever",
-- which is what the monitoring OFF switch is for — conflating the two is how
-- frames get silently dropped with no dial that explains it.

ALTER TABLE "AdminSetting" ADD COLUMN "screenshotSummaryMaxCallsPerDevicePerDay" INTEGER NOT NULL DEFAULT 8;

ALTER TABLE "AdminSetting"
  ADD CONSTRAINT "AdminSetting_screenshotSummaryMaxCallsPerDevicePerDay_positive" CHECK ("screenshotSummaryMaxCallsPerDevicePerDay" >= 1);
