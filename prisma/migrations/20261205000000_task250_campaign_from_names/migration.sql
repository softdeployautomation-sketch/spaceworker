-- TASK_250 — campaign sender display names (fromNames).
-- Additive only: fromNames on EmailCampaign, resolvedFromName on EmailQueueItem.
-- Zero behaviour change until from names are supplied at campaign creation.
ALTER TABLE "EmailCampaign" ADD COLUMN "fromNames" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "EmailQueueItem" ADD COLUMN "resolvedFromName" TEXT;
