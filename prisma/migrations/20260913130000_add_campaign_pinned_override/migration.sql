-- Task 33 — a temporary, human-approved "pinned override" window on a campaign:
-- { subject, bodyHtml, fromAddress, remaining } locking the campaign onto one
-- proven-good combination for a fixed number of sends (see schema comment).
-- Additive JSONB column; NULL = not pinned.
ALTER TABLE "EmailCampaign" ADD COLUMN "pinnedOverride" JSONB;