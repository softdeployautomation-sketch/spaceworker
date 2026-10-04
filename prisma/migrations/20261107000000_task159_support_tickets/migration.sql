-- TASK_159 — support tickets. Scope: PLAN_TASK_159_SUPPORT_TICKETS.md.
--
-- Two tables, deliberately not one. A ticket is the container (owner, status,
-- subject, the domain it is about); a message is an append-only turn in the thread.
-- Flattening them would put the ticket's status on every message row and make
-- "what is this ticket's status" a scan-or-guess.
--
-- WHAT IS DELIBERATELY *NOT* HERE, and why, so a later reader does not "fix" it:
--
--   * `SupportTicket.status` has NO CHECK constraint. It is a string precisely so
--     that "waiting_on_customer" is an INSERT and not a migration (plan §3.1). A
--     CHECK would reintroduce the migration the string was chosen to avoid. Readers
--     treat ONLY the exact value 'resolved' as closed; anything else — including a
--     value this code has never seen — still needs attention, so a future
--     "waiting_on_customer" can never silently drop out of the admin queue.
--   * `domainRefId` is a SOFT reference (no FK), the same shape UserDomain already
--     uses for `ownerUserId`. Two reasons: the plan forbids copying an apex into the
--     ticket (§3.3) so the join is required anyway, and a hard FK would make an
--     admin unable to remove a stale domain while a ticket still mentions it. The
--     "the domain must belong to this ticket's user" rule is enforced in the WRITE
--     path, not by the schema — same as the admin domain-add route's `userId` guard.
--   * `walletRefId` exists but is unused until the wallet ships. It is here now so
--     the tickets/wallet boundary (plan §6) is a visible column rather than a
--     retrofit. It is an ID, never an amount: a copied amount is a second source of
--     truth that will disagree with the ledger.

CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "subject" TEXT NOT NULL,
    "category" TEXT,
    "priority" TEXT,
    "domainRefId" TEXT,
    "walletRefId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- The two reads Phase 1 actually performs:
--   "my tickets, newest first"        -> (userId, createdAt)
--   the admin queue, "open first"     -> (status, createdAt)
CREATE INDEX "SupportTicket_userId_createdAt_idx" ON "SupportTicket"("userId", "createdAt");
CREATE INDEX "SupportTicket_status_createdAt_idx" ON "SupportTicket"("status", "createdAt");

-- RESTRICT, and that is a deliberate choice rather than the accidental default.
-- There is no account-deletion flow in this codebase today (searched), so this
-- blocks nothing that exists. What it guarantees is that support history can never
-- be destroyed as a SIDE EFFECT of removing a user: whoever builds deletion later
-- must make an explicit decision about tickets (plan §7.4 leaves retention open),
-- instead of silently losing every message a customer ever sent us.
ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- The thread read: one ticket's messages, in order.
CREATE INDEX "SupportMessage_ticketId_createdAt_idx" ON "SupportMessage"("ticketId", "createdAt");

-- CASCADE here, unlike the ticket's own FK above, and the difference is the point.
-- A message has no meaning without its ticket, so this is containment: deleting a
-- ticket (an explicit admin act) must not leave orphaned bodies behind that no UI
-- can show and no user can erase. It is not a retention policy.
ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `authorRole` IS a closed set, so it IS constrained — the exact opposite of
-- `SupportTicket.status` above. Only two writers exist in the entire design (the
-- ticket's user, and an admin), and every reader branches on this to decide how to
-- render the bubble, so an unknown value has no correct rendering at all. Unlike
-- status, no third value is anticipated.
ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_authorRole_chk"
  CHECK ("authorRole" IN ('user', 'admin'));

-- Structural floor, not validation. The full rules (length caps, non-empty after
-- trim) live in the zod schemas on both write routes; this only keeps an empty or
-- whitespace-only body out of the table even if it arrives from a migration, a
-- script, or a future admin tool that forgets to validate.
ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_body_chk"
  CHECK (length(btrim("body")) > 0);

-- Same floor for the subject: a ticket titled "" is unfindable in the queue.
ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_subject_chk"
  CHECK (length(btrim("subject")) > 0);
