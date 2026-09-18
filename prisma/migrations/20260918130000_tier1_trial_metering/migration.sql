-- Tier 1 trial for all free users: 15 min/day per tool, never prioritized over
-- Premium. Four schema changes, plus a one-time data backfill:
--   1. User.tier default 0 -> 1 (new signups get the trial tier immediately).
--   2. ToolUsageLog — append-only per-user, per-tool daily usage log (mirrors
--      AiUsageLog Task 40): one row per completed active run window, summed per
--      user+tool+UTC day for the 900s/day cap.
--   3. SearchJob.trialStartedAt — when this user+job's run entered "running"
--      (dispatch start), so the trial tally can measure real wall-clock elapsed
--      seconds for the extractor tool.
--   4. EmailCampaign.sendingStartedAt — when the campaign entered its current
--      active "sending" stretch (start of metered mailer usage).
--
-- Data backfill: existing rows are NOT touched by the default change above.
-- Bump existing tier-0 users to tier 1 (trial) ONLY when they came through the
-- real signup flow (acceptedTermsAt IS NOT NULL) — an inline EXE-buyer account
-- (findOrCreateUser in billing/submit, acceptedTermsAt IS NULL) MUST stay tier 0
-- or it would silently gain full web (dashboard) access it never signed up for.
ALTER TABLE "User" ALTER COLUMN "tier" SET DEFAULT 1;

ALTER TABLE "SearchJob" ADD COLUMN "trialStartedAt" TIMESTAMP(3);

ALTER TABLE "EmailCampaign" ADD COLUMN "sendingStartedAt" TIMESTAMP(3);

CREATE TABLE "ToolUsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "elapsedSeconds" INTEGER NOT NULL,
    "usedOn" TEXT NOT NULL,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolUsageLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ToolUsageLog_userId_tool_usedOn_idx" ON "ToolUsageLog"("userId", "tool", "usedOn");
CREATE INDEX "ToolUsageLog_userId_createdAt_idx" ON "ToolUsageLog"("userId", "createdAt");
ALTER TABLE "ToolUsageLog" ADD CONSTRAINT "ToolUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "User" SET "tier" = 1 WHERE "tier" = 0 AND "acceptedTermsAt" IS NOT NULL;
