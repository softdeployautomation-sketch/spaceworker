-- TASK_187 S3 (MONEY) — PremiumInvoice.days (admin term override) +
-- SupportMessage.invoiceId (thread invoice reference).
--
-- ADDITIVE only (house rule): two new NULLABLE columns + one CHECK. No existing
-- row or column is touched, so behavior for everyone who isn't sent a
-- TASK_187 invoice is bit-for-bit unchanged:
--   * "days" NULL = the standard term — settleLinkedInvoice reads
--     `days ?? PREMIUM_DAYS_PER_CHARGE`, so old rows need no backfill;
--     the CHECK refuses <= 0 because a garbage term would silently grant a
--     wrong term on payment approval, which is a money bug that only shows
--     up weeks later.
--   * "invoiceId" is a SOFT reference (no FK), house style like
--     SupportTicket.domainRefId: the message body must survive anything that
--     could ever happen to the invoice row, and readers treat a missing
--     invoice as "no invoice attached" rather than failing the thread read.

ALTER TABLE "PremiumInvoice" ADD COLUMN "days" INTEGER;

ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_days_check"
    CHECK ("days" IS NULL OR "days" >= 1);

ALTER TABLE "SupportMessage" ADD COLUMN "invoiceId" TEXT;