-- TASK_184 B4 — Payment.invoiceId: the OPTIONAL link from a payment to the
-- PremiumInvoice it settles ("invoice ref optional" per the B4 contract).
--
-- ADDITIVE only (house rule): one nullable column + index + FK. Every existing
-- Payment row gets NULL — no behavior change for any payment that was never
-- submitted against an invoice, which is every payment so far.
--
-- FK ON DELETE RESTRICT (explicit, mirroring ExeLicense.payment): a settled
-- payment pointing at a deleted invoice would be money with no record of what
-- it bought — deletion must refuse, never orphan.

ALTER TABLE "Payment" ADD COLUMN "invoiceId" TEXT;

CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "PremiumInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
