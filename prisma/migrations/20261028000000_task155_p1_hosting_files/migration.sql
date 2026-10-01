-- TASK_155 P1 — the hosting FILES engine (PLAN §7/§9). Purely ADDITIVE and
-- OFF by default: `hostingEnabled` defaults false, so applying this changes NO
-- existing behaviour and rewrites NO row. Two new empty tables (HostedAsset,
-- HostingUsageMonthly) create nothing for any existing account.
--
--   * The ten AdminSetting columns are the admin-editable caps of PLAN §14
--     (CROSS-TRACK RULE 7 — nothing hardwired; owner 2026-10-01: "we can add to
--     the admin where those limits can be easily changed").
--   * `hostingFreeMaxBandwidthGbPerMonth` and `hostingPremiumStorageQuotaMb`
--     start high enough that they never bite a first, single user.
--   * `hostingPagesMaxAssetMb` = 20 MUST stay < 25: Cloudflare 500s above 25 MiB
--     (witnessed live, PLAN §9 R3).
--
-- Generated with `prisma migrate diff` (old datamodel -> new datamodel); column
-- order is alphabetical, matching the tool's output, so this file stays
-- reproducible from the datamodel.

-- AlterTable
ALTER TABLE "AdminSetting" ADD COLUMN     "hostingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hostingFreeMaxBandwidthGbPerMonth" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "hostingFreeMaxFileSizeMb" INTEGER NOT NULL DEFAULT 512,
ADD COLUMN     "hostingFreeMaxFiles" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "hostingFreeStorageQuotaMb" INTEGER NOT NULL DEFAULT 1024,
ADD COLUMN     "hostingModulePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 9,
ADD COLUMN     "hostingPagesMaxAssetMb" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "hostingPlatformTokenTtlHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "hostingPremiumStorageQuotaMb" INTEGER NOT NULL DEFAULT 10240,
ADD COLUMN     "hostingProvider" TEXT NOT NULL DEFAULT 'local';

-- CreateTable
CREATE TABLE "HostedAsset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'file',
    "name" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "slug" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'local',
    "storagePath" TEXT,
    "externalId" TEXT,
    "sha256" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mime" TEXT NOT NULL,
    "dispositionFilename" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "url" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "bytesServed" BIGINT NOT NULL DEFAULT 0,
    "uploadIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "HostedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HostingUsageMonthly" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "bytesServed" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingUsageMonthly_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HostedAsset_token_key" ON "HostedAsset"("token");

-- CreateIndex
CREATE UNIQUE INDEX "HostedAsset_slug_key" ON "HostedAsset"("slug");

-- CreateIndex
CREATE INDEX "HostedAsset_userId_status_idx" ON "HostedAsset"("userId", "status");

-- CreateIndex
CREATE INDEX "HostedAsset_status_expiresAt_idx" ON "HostedAsset"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "HostingUsageMonthly_userId_period_key" ON "HostingUsageMonthly"("userId", "period");
