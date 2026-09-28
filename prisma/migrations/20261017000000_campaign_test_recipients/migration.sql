-- The test-send flow's own settings, so a campaign's owner can experiment with
-- WHO it's tested against and WHAT From address it goes out as, without any of
-- that touching a real send. Neither column is read by the send path.
--
-- testRecipientPool: shortlist of addresses to test against, so switching the
-- target mid-test is one click instead of retyping. The ACTIVE one stays in
-- "testRecipientOverride" (already existing) — this is only the picker's list.
-- testFromOverride: From address every TEST send uses, overriding the mailbox's
-- fromAddresses rotation (the "is the From what's causing spam?" lever).
ALTER TABLE "EmailCampaign" ADD COLUMN "testRecipientPool" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "EmailCampaign" ADD COLUMN "testFromOverride" TEXT;
