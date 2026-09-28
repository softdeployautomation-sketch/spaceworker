-- Classifies EmailQueueItem.error into something the drain can act on
-- (hard_bounce / soft_bounce / rate_limited / auth_failed), adds retry
-- support (attempts + nextAttemptAt) for transient failures, and a per-user
-- Suppression list so a hard-bounced address is never queued into a future
-- campaign of that same user's again.
ALTER TABLE "EmailQueueItem" ADD COLUMN "errorCategory" TEXT;
ALTER TABLE "EmailQueueItem" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EmailQueueItem" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX "EmailQueueItem_status_nextAttemptAt_idx" ON "EmailQueueItem"("status", "nextAttemptAt");

CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Suppression_userId_idx" ON "Suppression"("userId");
CREATE UNIQUE INDEX "Suppression_userId_email_key" ON "Suppression"("userId", "email");

ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- TASK_134 — premium regional proxy routing for campaign sends, reusing the
-- existing exit-node infra (lib/exit-nodes.ts). null = direct (default).
ALTER TABLE "Mailbox" ADD COLUMN "sendRegion" TEXT;
