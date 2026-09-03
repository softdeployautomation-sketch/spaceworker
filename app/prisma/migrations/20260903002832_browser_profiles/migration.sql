-- CreateTable
CREATE TABLE "BrowserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dirPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrowserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrowserProfile_userId_idx" ON "BrowserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserProfile_userId_name_key" ON "BrowserProfile"("userId", "name");

-- AddForeignKey
ALTER TABLE "BrowserProfile" ADD CONSTRAINT "BrowserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
