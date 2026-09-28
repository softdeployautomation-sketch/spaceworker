-- The user's saved default region for lead-extraction jobs (premium,
-- mirrors Mailbox.sendRegion's exact pattern). null = direct (default).
ALTER TABLE "User" ADD COLUMN "extractProxyRegion" TEXT;
