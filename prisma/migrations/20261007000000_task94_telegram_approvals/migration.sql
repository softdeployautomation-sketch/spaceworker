-- Task 94 — Telegram approval loop. A separate toggle from notifyTelegram:
-- that one is "send me event notifications there", this one is "let me
-- approve/reject agent proposals from Telegram". Default off, same
-- reasoning as notifyTelegram — a no-op until the user opts in AND links.
ALTER TABLE "User" ADD COLUMN "telegramApprovalsEnabled" BOOLEAN NOT NULL DEFAULT false;
