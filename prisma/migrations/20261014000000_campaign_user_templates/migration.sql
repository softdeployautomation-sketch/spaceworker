-- Users can flag one of their own campaigns as reusable ("My campaigns" group
-- in the template picker); admins can then promote a flagged one into the
-- system-owned "Ready-made templates" group. promotedTemplateId tracks that
-- promotion so it can only happen once per source campaign.
ALTER TABLE "EmailCampaign" ADD COLUMN "savedAsTemplate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailCampaign" ADD COLUMN "promotedTemplateId" TEXT;
