-- Task 40 — per-user daily AI cost caps + append-only usage audit log.
-- User.aiDailyCapHundredthsCent: the per-user daily ceiling (hundredths of a
-- cent; default 20000 = $2/day). Admin-adjustable via PATCH /api/admin/ai-usage.
-- AiUsageLog: the REAL cost Channelry reported per completed AI call (never an
-- estimate). "Today" is a SUM over rows with createdAt >= startOfTodayUTC —
-- race-safe under concurrency, unlike a mutable counter (see DeliverabilityCheck
-- / NotificationLog precedent).
ALTER TABLE "User" ADD COLUMN "aiDailyCapHundredthsCent" INTEGER NOT NULL DEFAULT 20000;

CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "costHundredthsCent" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;