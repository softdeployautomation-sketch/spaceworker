-- Task 47 addition — durable audit log for admin device transfers (moving an
-- already-bound EXE license to a new machine). Additive and backward-compatible:
-- a new table only, no changes to ExeLicense's existing columns.

-- CreateTable
CREATE TABLE "ExeLicenseTransfer" (
    "id" TEXT NOT NULL,
    "exeLicenseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromMachineId" TEXT,
    "toMachineId" TEXT NOT NULL,
    "fromMachineLabel" TEXT,
    "toMachineLabel" TEXT,
    "note" TEXT,
    "transferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExeLicenseTransfer_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ExeLicenseTransfer" ADD CONSTRAINT "ExeLicenseTransfer_exeLicenseId_fkey" FOREIGN KEY ("exeLicenseId") REFERENCES "ExeLicense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExeLicenseTransfer" ADD CONSTRAINT "ExeLicenseTransfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ExeLicenseTransfer_exeLicenseId_transferredAt_idx" ON "ExeLicenseTransfer"("exeLicenseId", "transferredAt");

-- CreateIndex
CREATE INDEX "ExeLicenseTransfer_userId_idx" ON "ExeLicenseTransfer"("userId");
