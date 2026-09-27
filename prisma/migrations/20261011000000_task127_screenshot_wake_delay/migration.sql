-- "Start monitoring N minutes after this device comes back online." Null/0 =
-- start as soon as it's online and due (today's behaviour).
ALTER TABLE "Device" ADD COLUMN "screenshotWakeDelayMinutes" INTEGER;
-- Internal bookkeeping: when lib/device-screenshots.ts last observed the
-- device transition offline -> online. Never user-set directly.
ALTER TABLE "Device" ADD COLUMN "screenshotOnlineSinceAt" TIMESTAMP(3);
