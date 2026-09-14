-- Task 39 — multi-channel notifications.
-- Per-channel preferences + Telegram linking on the User model.
--   notifyEmail / notifyAgent default ON (a user who never opens Settings keeps
--   today's email behavior and gets the new agent-chat channel).
--   notifyTelegram defaults OFF (a no-op until the user links a chat).
--   telegramChatId / telegramLinkToken are set/cleared only by the Telegram
--   linking webhook and the settings-notifications route.
ALTER TABLE "User" ADD COLUMN "notifyEmail" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "notifyTelegram" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "notifyAgent" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "telegramChatId" TEXT;
ALTER TABLE "User" ADD COLUMN "telegramLinkToken" TEXT;