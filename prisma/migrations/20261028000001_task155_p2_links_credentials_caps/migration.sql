-- TASK_155 P2 + TASK_156 C1 scaffolding. Purely ADDITIVE: nine AdminSetting
-- columns, two nullable LinkRedirect columns (plus their indexes) and one new
-- empty table. Every column is NOT NULL DEFAULT <value> or NULLABLE, so applying
-- this rewrites NO existing row and changes NO existing behaviour.
--
--   * `hostingFreeMaxLinks` — the P2 per-free-user cap on user-owned redirect
--     links (PLAN_TASK_155 §14: caps live on AdminSetting, are admin-editable,
--     and are enforced server-side).
--   * `LinkRedirect.userId` / `LinkRedirect.slug` — the P2 promotion of the
--     Task 30 cloaked link into a user-owned short link. BOTH are NULLABLE, so
--     every existing anonymous campaign link is untouched: it keeps a NULL
--     userId, a NULL slug and resolves exactly as before via /r/<token>.
--   * `HostingCredential` — the user's own hosting credential (BYO Cloudflare
--     account id + token), stored AES-256-GCM-encrypted. A brand-new empty table,
--     so it creates nothing for any existing account.
--   * The eight `cyberlab*` columns are TASK_156 C1 scaffolding the owner asked
--     for up front (2026-10-01): "all caps for the workers and cyberlab …
--     available for edit in admin". Nothing reads them yet — they exist so the
--     owner can see and tune the lab's load envelope before the lab ships, and
--     so the resource governor (TASK_105) has the RAM budget
--     (`cyberlabHostRamBudgetMb`, `cyberlabRangeRamMb`) to queue against when the
--     heavy tooling lands. `cyberlabEnabled` defaults false, so the lab is dark.
--
-- Generated with `prisma migrate diff` (old datamodel -> new datamodel); column
-- order is alphabetical, matching the tool's output, so this file stays
-- reproducible from the datamodel.

-- AlterTable
ALTER TABLE "AdminSetting" ADD COLUMN     "cyberlabEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cyberlabFreeMaxConcurrentRanges" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "cyberlabFreeMaxRangeMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "cyberlabHostRamBudgetMb" INTEGER NOT NULL DEFAULT 8192,
ADD COLUMN     "cyberlabMaxEpisodesPerMonth" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "cyberlabMaxTargetsPerScenario" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "cyberlabModulePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 29,
ADD COLUMN     "cyberlabRangeRamMb" INTEGER NOT NULL DEFAULT 2048,
ADD COLUMN     "hostingFreeMaxLinks" INTEGER NOT NULL DEFAULT 50;

-- AlterTable
ALTER TABLE "LinkRedirect" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "HostingCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'cloudflare',
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "tokenIv" TEXT NOT NULL,
    "tokenTag" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HostingCredential_userId_provider_idx" ON "HostingCredential"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "LinkRedirect_slug_key" ON "LinkRedirect"("slug");

-- CreateIndex
CREATE INDEX "LinkRedirect_userId_idx" ON "LinkRedirect"("userId");
