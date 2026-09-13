-- Task 29 — picker fixes, recipient control, deliverability hardening.
-- All additive except CampaignAutomation.personalListId -> personalListIds, which
-- backfills existing rows first so no single-list automation loses its list.

-- Item 4: independent subject/body rotation lists on a campaign (additive).
ALTER TABLE "EmailCampaign" ADD COLUMN "subjects" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "EmailCampaign" ADD COLUMN "bodies" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Item 3: queue-item provenance marker (empty = extracted/uploaded/picked).
ALTER TABLE "EmailQueueItem" ADD COLUMN "source" TEXT NOT NULL DEFAULT '';
-- Item 4: resolved subject/body snapshots for decoupled campaigns.
ALTER TABLE "EmailQueueItem" ADD COLUMN "resolvedSubject" TEXT;
ALTER TABLE "EmailQueueItem" ADD COLUMN "resolvedBodyHtml" TEXT;

-- Item 5: per-user seed/test mailbox ownership (null = platform share).
ALTER TABLE "SeedMailbox" ADD COLUMN "userId" TEXT;
ALTER TABLE "SeedMailbox" ADD CONSTRAINT "SeedMailbox_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SeedMailbox_userId_idx" ON "SeedMailbox"("userId");

-- Item 6: where the test message actually landed.
ALTER TABLE "DeliverabilityCheck" ADD COLUMN "landedIn" TEXT;

-- Item 2: single personalListId -> multi personalListIds (backfilled).
ALTER TABLE "CampaignAutomation" ADD COLUMN "personalListIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "CampaignAutomation" SET "personalListIds" = ARRAY["personalListId"]
  WHERE "personalListId" IS NOT NULL;
ALTER TABLE "CampaignAutomation" DROP COLUMN "personalListId";