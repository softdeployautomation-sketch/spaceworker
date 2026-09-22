-- Device console follow-ups (user-reported batch):
--   1. VantraLink.orgTier — the org's agent-domain tier at last sync; gates the
--      Add-a-device Public/Private toggle (private = premium/admin-granted).
--   2. DeviceQueuedCommand scheduleKind/wakeDelayMinutes — the Command tab's
--      "run now (next check-in)" vs "run N minutes after the device comes on"
--      timer. Vantra's sweep (QueuedAgentCommand) honors the same values.

ALTER TABLE "VantraLink" ADD COLUMN "orgTier" TEXT NOT NULL DEFAULT 'public';
ALTER TABLE "VantraLink" ADD COLUMN "privateOrgId" TEXT;
ALTER TABLE "VantraLink" ADD COLUMN "privatePsCommand" TEXT;
ALTER TABLE "VantraLink" ADD COLUMN "privatePsExpiresAt" TIMESTAMP(3);

ALTER TABLE "DeviceQueuedCommand" ADD COLUMN "scheduleKind" TEXT NOT NULL DEFAULT 'next_checkin';
ALTER TABLE "DeviceQueuedCommand" ADD COLUMN "wakeDelayMinutes" INTEGER NOT NULL DEFAULT 0;
