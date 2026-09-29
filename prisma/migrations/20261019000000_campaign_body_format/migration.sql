-- Task 144 — EmailCampaign.bodyFormat: "html" (default) or "text".
--
-- "text" sends the campaign body as a single text/plain part instead of HTML,
-- which is the strongest available lever against markup-based spam heuristics.
-- Additive with a default, so every existing campaign keeps its current
-- behaviour ("html") and no backfill is needed.
ALTER TABLE "EmailCampaign" ADD COLUMN "bodyFormat" TEXT NOT NULL DEFAULT 'html';
