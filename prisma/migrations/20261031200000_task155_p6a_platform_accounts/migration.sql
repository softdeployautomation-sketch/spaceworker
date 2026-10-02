-- TASK_155 P6a — platform Cloudflare accounts (PLAN §19): "ours should be the
-- premium". Purely ADDITIVE: one new table (HostingPlatformAccount) plus one
-- AdminSetting kill-switch column. Applying this rewrites NO existing row and
-- changes NO existing behaviour — with zero platform rows the Premium (ours)
-- site engine fails on the empty roster with a setup message, and the kill
-- switch defaults TRUE so the new engine is routable the moment the admin adds
-- the first account.
--
--   * HostingPlatformAccount — OUR Cloudflare accounts (no userId: ownership is
--     the platform; rotation is `priority`, lowest healthy serves). Same
--     AES-256-GCM token discipline as HostingCredential (ciphertext + iv + tag,
--     never plaintext). Health contract mirrors HostingCredential: verifyError
--     non-null (or status != "active") => rotation SKIPS the row, never uses it.
--   * hostingPlatformCfEnabled — master kill-switch for the platform engine.

-- CreateTable
CREATE TABLE "HostingPlatformAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenCiphertext" TEXT NOT NULL,
    "tokenIv" TEXT NOT NULL,
    "tokenTag" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL DEFAULT '',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastVerifiedAt" TIMESTAMP(3),
    "verifyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HostingPlatformAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HostingPlatformAccount_status_priority_idx" ON "HostingPlatformAccount"("status", "priority");

-- AlterTable
ALTER TABLE "AdminSetting" ADD COLUMN "hostingPlatformCfEnabled" BOOLEAN NOT NULL DEFAULT true;
