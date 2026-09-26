-- Third, separate Telegram toggle: "talk to the agent from Telegram", not
-- just tap approve/reject buttons on its pushes. Default off (opt-in).
ALTER TABLE "User" ADD COLUMN "telegramChatEnabled" BOOLEAN NOT NULL DEFAULT false;
