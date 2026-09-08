-- Task 17: decouple a Mailbox's SMTP login from its From address.
-- Purely additive nullable column: null means "send as username" (existing behavior).
ALTER TABLE "Mailbox" ADD COLUMN "fromAddress" TEXT;