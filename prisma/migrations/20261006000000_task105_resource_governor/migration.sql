-- TASK_105 — Resource Governor: the pressure model + the durable wait list.
--
-- Hand-written (never `migrate dev`), then verified statement-for-statement
-- against Prisma's own expected DDL:
--   npx prisma migrate diff --from-schema-datamodel <pre-TASK105 schema> \
--     --to-schema-datamodel prisma/schema.prisma --script
-- Column order, index names and the FK action below are exactly what that
-- comparison produced, so a later `prisma migrate diff` against a database
-- migrated with this file is a no-op (the drift check in HOW_WE_MOVE_FAST §6b).
--
-- WHY: today each high-RAM feature has its own cap (dispatch lanes, browser
-- sessions, Vantra links, device actions; Browser Clone adds clone sessions +
-- the pooled hosted PC), but nothing reacts to ACTUAL load — three features can
-- each be "under their cap" and still push the VPS into swap. The governor is
-- one server-side place that reads real pressure (RAM used %, swap, CPU load,
-- per-feature running count) and QUEUES any high-RAM feature at its limit.
--
-- Defaults are chosen so this migration is purely additive: the governor is OFF
-- by default, so every feature keeps today's plain cap behaviour and the queue
-- table stays empty until an admin turns it on. Nothing here hardwires a limit
-- (plan CROSS-TRACK RULE 7 — every threshold is an AdminSetting).

-- AdminSetting — the governor's PRESSURE MODEL (all admin-tunable at runtime).
--   governorEnabled              master switch; false = today's behaviour exactly
--   governorRamWarnPct           premium stops bypassing a full feature at/above
--   governorRamHardPct           EVERYONE queues (premium included) at/above
--   governorSwapHardMb           swap-in-use (MB) that also counts as "full"
--   governorQueueTimeoutSec      how long a queued request may wait
--   governorStarvationPromoteMin free/trial wait before promotion to premium
ALTER TABLE "AdminSetting" ADD COLUMN "governorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminSetting" ADD COLUMN "governorRamWarnPct" INTEGER NOT NULL DEFAULT 75;
ALTER TABLE "AdminSetting" ADD COLUMN "governorRamHardPct" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "AdminSetting" ADD COLUMN "governorSwapHardMb" INTEGER NOT NULL DEFAULT 1024;
ALTER TABLE "AdminSetting" ADD COLUMN "governorQueueTimeoutSec" INTEGER NOT NULL DEFAULT 900;
ALTER TABLE "AdminSetting" ADD COLUMN "governorStarvationPromoteMin" INTEGER NOT NULL DEFAULT 10;

-- The wait list. Persisted precisely so a queued request survives
-- `systemctl restart spaceworker`; the sweep timer (deploy/governor-sweep.{service,timer})
-- releases expired entries, promotes starved ones and drains the head.
-- FK policy: this is OPERATIONAL wait state, not an audit record, so userId is
-- ON DELETE CASCADE (plan RULE 5's "audit rows must outlive their subject" does
-- not apply — a stale wait-list row for a deleted account has nothing to keep).
CREATE TABLE "GovernorQueueEntry" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ref" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "position" INTEGER NOT NULL DEFAULT 0,
    "promotedAt" TIMESTAMP(3),
    "reason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),

    CONSTRAINT "GovernorQueueEntry_pkey" PRIMARY KEY ("id")
);

-- Drain order: feature + status + class + arrival (the FIFO read).
CREATE INDEX "GovernorQueueEntry_feature_status_priority_requestedAt_idx" ON "GovernorQueueEntry"("feature", "status", "priority", "requestedAt");
-- Idempotent re-request by the caller's own handle (a CloneJob id).
CREATE INDEX "GovernorQueueEntry_feature_ref_status_idx" ON "GovernorQueueEntry"("feature", "ref", "status");
CREATE INDEX "GovernorQueueEntry_userId_status_idx" ON "GovernorQueueEntry"("userId", "status");
-- Expiry sweep.
CREATE INDEX "GovernorQueueEntry_status_expiresAt_idx" ON "GovernorQueueEntry"("status", "expiresAt");

ALTER TABLE "GovernorQueueEntry" ADD CONSTRAINT "GovernorQueueEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
