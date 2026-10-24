-- TASK_238 — Vantra's "online" verdict gets its own freshness anchor.
--
-- Additive only: one nullable column. lastSeenAt keeps its exact meaning (the
-- last real heartbeat); this column records when the verdict was last observed
-- online, so an online device whose lastSeen is stale/omitted is not offline.
ALTER TABLE "Device" ADD COLUMN "onlineConfirmedAt" TIMESTAMP(3);
