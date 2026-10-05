-- TASK_166 — the support-ticket read cursor, for the unread badge on the support
-- button (owner, 2026-10-05: "the message delivered into the user, but it didn't show
-- like a notification on the support button").
--
-- ONE nullable column. Nullable on purpose: every row that exists today gets NULL,
-- and NULL is read as "never read" by the service, so a customer with an answer already
-- waiting sees the badge once and clears it. See the schema comment for why the
-- opposite default (NULL = read) would be the dangerous one.
--
-- No backfill, and no default. A `DEFAULT now()` would stamp every existing ticket as
-- read the instant this migration ran, permanently hiding any reply already sitting
-- unanswered — the precise bug this change exists to fix.
--
-- Deliberately NOT an index. The only query that reads this is the owner's own ticket
-- list, which is already served by the existing `[userId, createdAt]` index; adding a
-- second one for a single column on a low-traffic per-user table would be cost
-- without a plan to measure.

ALTER TABLE "SupportTicket" ADD COLUMN "lastReadAt" TIMESTAMP(3);