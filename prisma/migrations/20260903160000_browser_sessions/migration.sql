-- Task 7 — interactive private browser (Phase 1).
-- Adds per-profile BYO proxy settings to BrowserProfile and the new
-- BrowserSession model (a live, streamed interactive session).

-- AlterTable
ALTER TABLE "BrowserProfile" ADD COLUMN "byoProxyHost" TEXT,
ADD COLUMN "byoProxyPort" INTEGER,
ADD COLUMN "byoProxyScheme" TEXT,
ADD COLUMN "byoProxyUsername" TEXT,
ADD COLUMN "byoProxyAuth" TEXT;

-- CreateTable
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "proxyMode" TEXT NOT NULL DEFAULT 'free',
    "exitNodeId" TEXT,
    "byoProxyHost" TEXT,
    "byoProxyPort" INTEGER,
    "byoProxyScheme" TEXT,
    "byoProxyUsername" TEXT,
    "byoProxyAuth" TEXT,
    "containerId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrowserSession_userId_status_idx" ON "BrowserSession"("userId", "status");

-- CreateIndex
CREATE INDEX "BrowserSession_profileId_idx" ON "BrowserSession"("profileId");

-- AddForeignKey
ALTER TABLE "BrowserSession" ADD CONSTRAINT "BrowserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrowserSession" ADD CONSTRAINT "BrowserSession_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "BrowserProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;