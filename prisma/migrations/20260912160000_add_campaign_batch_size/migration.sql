-- Task 29, item 6 — batch-gate batch size (how many recipients a campaign drains
-- per tick before re-checking deliverability). Default 50 preserves a sane cadence
-- and is additive; existing campaigns get the default.
ALTER TABLE "EmailCampaign" ADD COLUMN "batchSize" INTEGER NOT NULL DEFAULT 50;