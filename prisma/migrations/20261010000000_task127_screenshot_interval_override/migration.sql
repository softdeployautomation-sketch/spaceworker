-- Per-device schedule override. Null (the default) means "use the admin's
-- global screenshotCaptureIntervalMinutes".
ALTER TABLE "Device" ADD COLUMN "screenshotIntervalMinutesOverride" INTEGER;
