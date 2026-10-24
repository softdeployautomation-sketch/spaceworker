-- TASK_239 — persist the exit-IP check verdict instead of swallowing it.
-- Additive only: three nullable columns on BrowserSession.
ALTER TABLE "BrowserSession" ADD COLUMN "exitIpError" TEXT;
ALTER TABLE "BrowserSession" ADD COLUMN "exitIpCheckedAt" TIMESTAMP(3);
ALTER TABLE "BrowserSession" ADD COLUMN "exitIpPath" TEXT;
