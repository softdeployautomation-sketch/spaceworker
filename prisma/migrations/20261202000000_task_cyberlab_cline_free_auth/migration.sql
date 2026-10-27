-- Cline free-tier auth: daily usage tracking (P4)
-- Additive only: creates ClineFreeUsage table for 2-free-accounts-per-day limit.

CREATE TABLE IF NOT EXISTS "ClineFreeUsage" (
    id TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ClineFreeUsage_userId_date_key" UNIQUE ("userId", date)
);

CREATE INDEX IF NOT EXISTS "ClineFreeUsage_userId_date_idx" ON "ClineFreeUsage"("userId", date);
