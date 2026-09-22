-- Task 95 — Devices v2 tool parity: queued-command mirror + PIN requests.

-- CreateTable
CREATE TABLE "DeviceQueuedCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shell" TEXT NOT NULL DEFAULT 'powershell',
    "cmd" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 30,
    "runAsUser" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "vantraQueueId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceQueuedCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePinRequest" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pinLength" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "pin" TEXT,
    "submittedAt" TIMESTAMP(3),
    "sourceIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DevicePinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DevicePinRequest_tokenHash_key" ON "DevicePinRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceQueuedCommand_deviceId_status_idx" ON "DeviceQueuedCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DeviceQueuedCommand_userId_createdAt_idx" ON "DeviceQueuedCommand"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DevicePinRequest_deviceId_status_idx" ON "DevicePinRequest"("deviceId", "status");

-- CreateIndex
CREATE INDEX "DevicePinRequest_userId_createdAt_idx" ON "DevicePinRequest"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeviceQueuedCommand" ADD CONSTRAINT "DeviceQueuedCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceQueuedCommand" ADD CONSTRAINT "DeviceQueuedCommand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePinRequest" ADD CONSTRAINT "DevicePinRequest_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DevicePinRequest" ADD CONSTRAINT "DevicePinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
