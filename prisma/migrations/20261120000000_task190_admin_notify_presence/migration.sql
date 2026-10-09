-- TASK_190 — admin notification channels + owner presence.
--
-- ADDITIVE only (house rule): two brand-new tables + five nullable/defaulted
-- columns on existing tables. No existing row or column is touched, so this
-- cannot change any behavior for anyone who isn't the admin flipping a toggle
-- or a user whose browser starts sending the TASK_190 heartbeat.
--
-- Design notes that live HERE because the database enforces them:
--  • AdminNotificationPref is a SINGLETON (id default 'singleton'): the admin
--    is not a User row (signed-token session), so their channel prefs cannot
--    live on User. Both channels default false — a missing row reads as "both
--    off", and the admin opts in per channel.
--  • UserPresenceEvent.userId cascades with User (operational history, not
--    audit — same rule as DeviceScreenshot: a frame/event of a deleted
--    account's has nothing to preserve). 90-day retention is app-side
--    (retention-sweep), so no TTL lives here.
--  • `state` is deliberately an UNCHECKED TEXT (house rule for evolving enums):
--    an unknown value must fail safe in the reader, never break a heartbeat
--    write. Device.adminNotify* default false/null — a device nobody opted in
--    is never notified on, byte-for-byte today's behavior.

ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastActiveAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "lastSeenPage" TEXT;

ALTER TABLE "Device" ADD COLUMN "adminNotifyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Device" ADD COLUMN "adminNotifyLastSentAt" TIMESTAMP(3);

CREATE TABLE "AdminNotificationPref" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "telegramEnabled" BOOLEAN NOT NULL DEFAULT false,
    "telegramChatId" TEXT,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminNotificationPref_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserPresenceEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "page" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserPresenceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserPresenceEvent_userId_createdAt_idx" ON "UserPresenceEvent"("userId", "createdAt");

ALTER TABLE "UserPresenceEvent" ADD CONSTRAINT "UserPresenceEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
