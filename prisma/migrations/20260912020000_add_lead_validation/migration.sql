-- Task 26, Piece 3 — email deliverability validation on leads.
-- Survival-mode email validation: syntax check + DNS MX lookup on the domain,
-- the same proven approach the standalone Lead Extractor uses (MX-record
-- checking, NOT SMTP handshakes). These three columns are added with a default /
-- NULL so every existing Lead row stays valid and only newly-created rows opt
-- into a non-default status.
ALTER TABLE "Lead" ADD COLUMN "validationStatus" TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE "Lead" ADD COLUMN "validationError" TEXT;
ALTER TABLE "Lead" ADD COLUMN "validatedAt" TIMESTAMP(3);