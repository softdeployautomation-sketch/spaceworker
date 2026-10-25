-- TASK_241 — exactly-once claim for the "new device added" notification.
-- ADD-COLUMN-ONLY plus a one-statement backfill: every existing row is marked
-- as already handled at its own creation time, so the first sync after deploy
-- cannot fire a "new device" ping for machines the owner already has.
ALTER TABLE "Device" ADD COLUMN     "addedNotifiedAt" TIMESTAMP(3);

UPDATE "Device" SET "addedNotifiedAt" = "createdAt" WHERE "addedNotifiedAt" IS NULL;
