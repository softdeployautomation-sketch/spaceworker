-- Owner-requested 2026-09-20: variable license terms at checkout (1 month /
-- 6 months / 1 year) and server-side visibility into the EXE's silent 24h
-- trial. Both additive: a nullable column on Payment (existing rows
-- unaffected, read back as "use the product's standard 180-day term") and a
-- new standalone table with no FK to anything user-owned (a trial is
-- anonymous by design).

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "durationDays" INTEGER;

-- CreateTable
CREATE TABLE "ExeTrialSession" (
    "id" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "machineLabel" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExeTrialSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExeTrialSession_machineId_product_key" ON "ExeTrialSession"("machineId", "product");

-- CreateIndex
CREATE INDEX "ExeTrialSession_startedAt_idx" ON "ExeTrialSession"("startedAt");
