-- TASK_184 B3 (MONEY) — PremiumInvoice: an admin-issued invoice for a premium
-- plan (Premium Plus tier 5 / Premium XDevice tier 3), the bridge between a
-- premium-request support ticket and an actual payment.
--
-- ADDITIVE only (house rule): one brand-new table + its FK/indexes. No existing
-- row or column is touched, so this cannot change any behavior for anyone who
-- isn't sent an invoice.
--
-- `plan` CHECK is CLOSED deliberately (unlike SupportTicket.status): an unknown
-- plan string would carry a garbage tier into the grant path, so it must refuse
-- at the database, not just in the route.
-- `tier` CHECK pins 3|5 — the only two tiers that exist as paid plans.
-- `status` stays UNCHECKED (String, default "open") — same reasoning as
-- SupportTicket.status: readers treat only "paid" as settled, so an unknown
-- value fails safe (still awaiting payment) instead of breaking a read.

CREATE TABLE "PremiumInvoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "methods" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "PremiumInvoice_pkey" PRIMARY KEY ("id")
);

-- Deleting a user must REFUSE (Restrict) — an invoice is payment evidence.
CREATE INDEX "PremiumInvoice_userId_createdAt_idx" ON "PremiumInvoice"("userId", "createdAt");
CREATE INDEX "PremiumInvoice_userId_status_idx" ON "PremiumInvoice"("userId", "status");

ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_plan_check"
    CHECK ("plan" IN ('premium_plus', 'premium_xdevice'));

ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_tier_check"
    CHECK ("tier" IN (3, 5));
