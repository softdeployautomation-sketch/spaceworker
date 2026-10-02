-- TASK_155 P3 — the Pages engine + folder→preview→publish. Purely ADDITIVE:
-- nine AdminSetting columns (every one NOT NULL DEFAULT <value>) and three new
-- empty tables. Applying this rewrites NO existing row and changes NO existing
-- behaviour — HostingSite/HostingRevision/HostingJob start empty, and the new
-- caps are only read by the P3 site engine (which does nothing until a user
-- creates a site). This is the same discipline as P1/P2.
--
--   * hostingPremiumMaxProjects / hostingPremiumMaxFilesPerProject /
--     hostingPremiumMaxBandwidthGbPerMonth / hostingPremiumDeploymentsPerDay /
--     hostingPreviewTtlHours / hostingMaxZipMb / hostingMaxZipEntries /
--     hostingMaxHeavyJobsPerUser / hostingPublishedRevisionsKept — the §16.3
--     premium cap family + the §16.6 heavy-load dials (PLAN §14 rule 1: every
--     limit is a named AdminSetting field, read server-side, admin-editable).
--   * HostingSite — a hosted static site; engine is a per-item column (§16.2).
--   * HostingRevision — the §16.1 uploaded→extracted→previewed→published state
--     machine; the last N published revisions are kept for one-click undo.
--   * HostingJob — the §16.6 single-slot lock + per-job load metrics.
--
-- Hand-written SQL (HOW_WE_MOVE_FAST rule 2); column order mirrors the datamodel.

-- AlterTable
ALTER TABLE "AdminSetting" ADD COLUMN     "hostingMaxHeavyJobsPerUser" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "hostingMaxZipEntries" INTEGER NOT NULL DEFAULT 20000,
ADD COLUMN     "hostingMaxZipMb" INTEGER NOT NULL DEFAULT 2048,
ADD COLUMN     "hostingPremiumDeploymentsPerDay" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "hostingPremiumMaxBandwidthGbPerMonth" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "hostingPremiumMaxFilesPerProject" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN     "hostingPremiumMaxProjects" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "hostingPreviewTtlHours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "hostingPublishedRevisionsKept" INTEGER NOT NULL DEFAULT 3;

-- AlterTable — TASK_155 P3 verify-on-save (§16.4). NULLABLE, so this is ADDITIVE:
-- an existing credential simply reads as "never verified" until its next save/use.
ALTER TABLE "HostingCredential" ADD COLUMN     "lastVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifyError" TEXT;

-- CreateTable
CREATE TABLE "HostingSite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'local',
    "credentialId" TEXT,
    "previewToken" TEXT NOT NULL,
    "liveToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "cfProject" TEXT,
    "liveUrl" TEXT,
    "previewUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostingRevision" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'uploaded',
    "archiveName" TEXT,
    "archiveBytes" INTEGER NOT NULL DEFAULT 0,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "manifest" JSONB,
    "storagePath" TEXT,
    "cfDeploymentId" TEXT,
    "cfUrl" TEXT,
    "previewToken" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "entries" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "peakRssMb" INTEGER NOT NULL DEFAULT 0,
    "rejection" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostingJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "bytesProcessed" BIGINT NOT NULL DEFAULT 0,
    "entries" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "peakRssMb" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "HostingJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostingSite_previewToken_key" ON "HostingSite"("previewToken");

-- CreateIndex
CREATE UNIQUE INDEX "HostingSite_liveToken_key" ON "HostingSite"("liveToken");

-- CreateIndex
CREATE INDEX "HostingSite_userId_status_idx" ON "HostingSite"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "HostingRevision_previewToken_key" ON "HostingRevision"("previewToken");

-- CreateIndex
CREATE INDEX "HostingRevision_siteId_state_idx" ON "HostingRevision"("siteId", "state");

-- CreateIndex
CREATE INDEX "HostingRevision_userId_createdAt_idx" ON "HostingRevision"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "HostingJob_userId_status_idx" ON "HostingJob"("userId", "status");
