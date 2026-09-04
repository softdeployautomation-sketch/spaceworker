-- Task 11 + Task 12: Lead Extractor templates + Mailer rewrite
--
-- Adds:
--   * SearchJob.template (which extractor template created the job)
--   * CampaignVariant (subject/body rotation)
--   * EmailCampaign.mailboxIds (true in-run sender rotation)
--   * EmailQueueItem.variantId + variables (which variant a recipient got, and
--     that recipient's CSV merge-variable rows)
--   * EmailCampaign.status now defaults to "pending_test_confirm" (existing rows
--     keep whatever they already had, including "draft"/"sending").
--   * SeedMailbox + DeliverabilityCheck (test-send-confirm deliverability gate)

-- AlterTable
ALTER TABLE "SearchJob" ADD COLUMN "template" TEXT NOT NULL DEFAULT 'lead';

-- AlterTable
ALTER TABLE "EmailCampaign"
    ADD COLUMN "mailboxIds" TEXT[] NOT NULL DEFAULT '{}',
    ALTER COLUMN "subject" SET DEFAULT '',
    ALTER COLUMN "bodyHtml" SET DEFAULT '',
    ALTER COLUMN "status" SET DEFAULT 'pending_test_confirm';

-- Backfill: campaigns created before this migration have an empty mailboxIds
-- (default '{}'), which makes them unsendable — the test/send paths resolve
-- senders via `where: { id: { in: campaign.mailboxIds } }`, and an empty array
-- matches nothing. Seed each existing campaign's mailboxIds from the distinct
-- mailbox values already assigned to its queued items (if any) so they can send.
UPDATE "EmailCampaign" ec
SET "mailboxIds" = ARRAY(
    SELECT DISTINCT i."mailboxId"
    FROM "EmailQueueItem" i
    WHERE i."campaignId" = ec."id" AND i."mailboxId" IS NOT NULL
);

-- AlterTable
ALTER TABLE "EmailQueueItem" ADD COLUMN "variantId" TEXT;
ALTER TABLE "EmailQueueItem" ADD COLUMN "variables" JSONB;

-- CreateTable
CREATE TABLE "CampaignVariant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedMailbox" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "passwordIv" TEXT NOT NULL,
    "passwordTag" TEXT NOT NULL,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeedMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverabilityCheck" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "seedMailboxId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "DeliverabilityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignVariant_campaignId_idx" ON "CampaignVariant"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedMailbox_username_key" ON "SeedMailbox"("username");

-- CreateIndex
CREATE INDEX "DeliverabilityCheck_campaignId_createdAt_idx" ON "DeliverabilityCheck"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailQueueItem_variantId_idx" ON "EmailQueueItem"("variantId");

-- Backfill: every existing campaign already has exactly one subject/body pair, so
-- migrate it into a CampaignVariant row so rotating/analytics code has 100% coverage
-- from the start (a campaign with a single variant behaves exactly like before).
INSERT INTO "CampaignVariant" ("id", "campaignId", "subject", "bodyHtml", "createdAt")
SELECT md5(('v:' || ec."id")::text)::uuid::text, ec."id", ec."subject", ec."bodyHtml", ec."createdAt"
FROM "EmailCampaign" ec;

-- AddForeignKey
ALTER TABLE "CampaignVariant" ADD CONSTRAINT "CampaignVariant_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailQueueItem" ADD CONSTRAINT "EmailQueueItem_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "CampaignVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverabilityCheck" ADD CONSTRAINT "DeliverabilityCheck_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverabilityCheck" ADD CONSTRAINT "DeliverabilityCheck_seedMailboxId_fkey"
    FOREIGN KEY ("seedMailboxId") REFERENCES "SeedMailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;