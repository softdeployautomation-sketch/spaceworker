-- TASK_249 — platform domain selectors (Cloudflare zones).
-- Additive only: two new nullable AdminSetting columns. Zero behaviour change
-- until an admin sets them, so safe to deploy before the UI/wiring lands.
ALTER TABLE "AdminSetting" ADD COLUMN "hostingPublicLinkHost" TEXT;
ALTER TABLE "AdminSetting" ADD COLUMN "hostingPublicLinksAccountId" TEXT;
