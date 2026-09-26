-- Ported from Vantra's proven device-status-check pattern. Both default true
-- (safety-relevant, unlike the opt-in Telegram-specific toggles).
ALTER TABLE "User" ADD COLUMN "notifyDeviceOffline" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyDeviceOnline" BOOLEAN NOT NULL DEFAULT true;
-- Null means "never swept yet" -- first sweep never fires a spurious transition.
ALTER TABLE "Device" ADD COLUMN "lastNotifiedOnline" BOOLEAN;
