-- Task 30 — preview, sending-activity modal, optional link-redirect cloaking, and
-- multi-From rotation.
--
-- All additive except Mailbox.fromAddress -> fromAddresses, which backfills
-- existing values into a single-item array first (same precedent as
-- CampaignAutomation.personalListId -> personalListIds in Task 29), and the old
-- column is dropped after that backfill.

-- Item 4: Mailbox single fromAddress -> multiple fromAddresses (backfilled).
ALTER TABLE "Mailbox" ADD COLUMN "fromAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "Mailbox" SET "fromAddresses" = ARRAY["fromAddress"] WHERE "fromAddress" IS NOT NULL;
ALTER TABLE "Mailbox" DROP COLUMN "fromAddress";

-- Item 4: per-item resolved From address, computed at queue-build time.
ALTER TABLE "EmailQueueItem" ADD COLUMN "resolvedFromAddress" TEXT;

-- Item 3: link-redirect cloaking table (public /r/<token> route).
CREATE TABLE "LinkRedirect" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "campaignId" TEXT,
    "target" TEXT NOT NULL,
    "label" TEXT,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LinkRedirect_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LinkRedirect_token_key" ON "LinkRedirect"("token");
ALTER TABLE "LinkRedirect" ADD CONSTRAINT "LinkRedirect_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "LinkRedirect_campaignId_idx" ON "LinkRedirect"("campaignId");