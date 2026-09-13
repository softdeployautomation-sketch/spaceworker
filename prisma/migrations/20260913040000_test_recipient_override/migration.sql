-- Human-assisted deliverability fallback: a campaign can designate a plain ad-hoc
-- recipient as its test target instead of a registered SeedMailbox (used either
-- proactively at creation, or reactively after the platform seed mailbox's
-- automated check fails). All additive/widening except the seedMailboxId FK,
-- which is widened to nullable (existing rows all have a real seedMailboxId
-- already, so this is a pure loosening, not a data change).

ALTER TABLE "EmailCampaign" ADD COLUMN "testRecipientOverride" TEXT;

ALTER TABLE "DeliverabilityCheck" ADD COLUMN "overrideRecipient" TEXT;
ALTER TABLE "DeliverabilityCheck" ALTER COLUMN "seedMailboxId" DROP NOT NULL;
