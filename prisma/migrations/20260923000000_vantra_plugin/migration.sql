-- Task 93 — Vantra plugin: per-user link + admin limits (CROSS-TRACK RULE 7).
CREATE TABLE "VantraLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "agentTokenEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending_install',
    "installTokenHash" TEXT,
    "installTokenExpiresAt" TIMESTAMP(3),
    "installUrl" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VantraLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VantraLink_userId_key" ON "VantraLink"("userId");
CREATE INDEX "VantraLink_orgId_idx" ON "VantraLink"("orgId");
CREATE INDEX "VantraLink_status_idx" ON "VantraLink"("status");

ALTER TABLE "VantraLink" ADD CONSTRAINT "VantraLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AdminSetting: vantra link + device-action limits (defaults match code).
ALTER TABLE "AdminSetting" ADD COLUMN "vantraLinksEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminSetting" ADD COLUMN "vantraLinksMax" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "AdminSetting" ADD COLUMN "deviceActionsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminSetting" ADD COLUMN "deviceActionsMaxConcurrent" INTEGER NOT NULL DEFAULT 3;