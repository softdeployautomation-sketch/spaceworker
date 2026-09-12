-- CreateTable
CREATE TABLE "CampaignAutomation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "leadSource" TEXT NOT NULL DEFAULT 'extract',
    "findTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locationTerms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "params" JSONB,
    "personalListId" TEXT,
    "campaignTemplateId" TEXT NOT NULL,
    "mailboxIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "triggerMode" TEXT NOT NULL DEFAULT 'manual',
    "scheduleHour" INTEGER,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CampaignAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignAutomationRun" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractionCompletedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "leadSource" TEXT NOT NULL,
    "searchJobId" TEXT,
    "leadsExtracted" INTEGER,
    "campaignId" TEXT,
    "emailsSent" INTEGER,
    "emailsSentByMailbox" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "CampaignAutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignAutomation_userId_idx" ON "CampaignAutomation"("userId");

-- CreateIndex
CREATE INDEX "CampaignAutomation_triggerMode_scheduleEnabled_idx" ON "CampaignAutomation"("triggerMode", "scheduleEnabled");

-- CreateIndex
CREATE INDEX "CampaignAutomationRun_automationId_startedAt_idx" ON "CampaignAutomationRun"("automationId", "startedAt");

-- AddForeignKey
ALTER TABLE "CampaignAutomation" ADD CONSTRAINT "CampaignAutomation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignAutomationRun" ADD CONSTRAINT "CampaignAutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "CampaignAutomation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;