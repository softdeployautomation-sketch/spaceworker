-- TASK_135 §6.3 — how much of the state transfer is still outstanding.
--
-- A device command cannot carry a whole browser profile: the run-command timeout
-- caps it well below the size of a real History database plus extensions. So the
-- device sends what it can within its own budget, reports how many files it did
-- not reach, and the next run continues from there — the target's cache already
-- holds what arrived, so the next plan asks only for the remainder.
--
--   NULL or 0 — nothing outstanding; the replica is as complete as the source
--               could make it.
--   > 0       — that many files are still to come. The clone can still launch on
--               what has landed, but the console must be able to SAY that, because
--               "the sync ran" and "the sync finished" are different claims.
--
-- Additive and nullable: every existing job row and every existing code path is
-- unchanged by this migration.

ALTER TABLE "CloneJob" ADD COLUMN "stateSyncPending" INTEGER;
