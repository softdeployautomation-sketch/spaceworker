-- Task 26, Piece 5 — (a) mailbox security opt-out + (b) campaign rotation batch size.
-- (a) allowInsecure: explicit only for the "None (port 25, unencrypted relay)" mode.
--     Default false preserves today's always-TLS behavior for every existing mailbox.
-- (b) rotateEvery: how many recipients share a mailbox/subject before rotation advances.
--     Default 1 reproduces the old per-recipient rotation exactly, so existing
--     campaigns keep identical behavior until the field is updated.
ALTER TABLE "Mailbox" ADD COLUMN "allowInsecure" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailCampaign" ADD COLUMN "rotateEvery" INTEGER NOT NULL DEFAULT 1;