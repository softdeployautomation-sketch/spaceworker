-- Cline device auth: temporary device-code mapping for OAuth device-flow login (P4)
-- Additive only: creates ClineDeviceAuth table for device code ↔ userId mapping.

CREATE TABLE IF NOT EXISTS "ClineDeviceAuth" (
    id TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "deviceCode" TEXT NOT NULL UNIQUE,
    "userCode" TEXT NOT NULL,
    "expiresAt" TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS "ClineDeviceAuth_userId_idx" ON "ClineDeviceAuth"("userId");
CREATE INDEX IF NOT EXISTS "ClineDeviceAuth_deviceCode_idx" ON "ClineDeviceAuth"("deviceCode");