-- Task 35 — configurable send pacing bounds. The drain route's per-send jitter
-- is `min + random * (max - min)` seconds between sends; the defaults (5/45)
-- reproduce task-35's pre-existing hardcoded `Math.random() * 40_000 + 5_000`
-- exactly, so existing campaigns see zero behavior change. Server-side clamping
-- (min >= 1, max >= min) lives in POST /api/campaigns and the drain route, never
-- only in the UI. Additive; existing rows get the 5/45 defaults.
ALTER TABLE "EmailCampaign" ADD COLUMN "minSendDelaySeconds" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "EmailCampaign" ADD COLUMN "maxSendDelaySeconds" INTEGER NOT NULL DEFAULT 45;