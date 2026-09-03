-- CreateTable
CREATE TABLE "SearchJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "lane" TEXT NOT NULL,
    "workerJobId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobQueueEntry" (
    "id" TEXT NOT NULL,
    "searchJobId" TEXT NOT NULL,
    "priorityTier" INTEGER NOT NULL,
    "lane" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobQueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "searchJobId" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "contactName" TEXT,
    "businessName" TEXT,
    "website" TEXT,
    "sourceUrl" TEXT,
    "snippet" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SearchJob_userId_createdAt_idx" ON "SearchJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobQueueEntry_searchJobId_key" ON "JobQueueEntry"("searchJobId");

-- CreateIndex
CREATE INDEX "JobQueueEntry_lane_status_priorityTier_createdAt_idx" ON "JobQueueEntry"("lane", "status", "priorityTier", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_userId_searchJobId_idx" ON "Lead"("userId", "searchJobId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_searchJobId_sourceUrl_key" ON "Lead"("searchJobId", "sourceUrl");

-- AddForeignKey
ALTER TABLE "SearchJob" ADD CONSTRAINT "SearchJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobQueueEntry" ADD CONSTRAINT "JobQueueEntry_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "SearchJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_searchJobId_fkey" FOREIGN KEY ("searchJobId") REFERENCES "SearchJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
