-- Task 123 (B12, PATH A) — Wake-on-LAN power identity.
--
-- Root cause (TASK_123_WAKE_ON_LAN.md §2): the current "Wake" button reads
-- the target's own MAC from MeshCentral's `if<node>` record (R1 — asking a
-- sleeping machine for its own MAC — structurally useless) and relays through
-- ANY agent in the same mesh rather than one on the same physical LAN (R2).
--
-- D1: record the MAC/IP ourselves, SYSTEM-side, during one-click setup
-- (lib/clone-setup.ts) — no dependency on MeshCentral's `if` records at all.
-- D2: `powerLanSubnet` is the computed /24 of the last-seen LAN IP, which
-- lib/wol.ts's selectWolPeer matches an online peer against (same-subnet
-- relay, never same-mesh).
--
-- All four columns are nullable: a device that has never run setup (or ran it
-- before this task) simply has no recorded power identity yet, and Wake fails
-- closed with "no_power_mac" (D3) rather than crashing or guessing. Rollback
-- is dropping these four columns — nothing else reads them yet.

ALTER TABLE "Device" ADD COLUMN "powerMac" TEXT;
ALTER TABLE "Device" ADD COLUMN "powerLanIp" TEXT;
ALTER TABLE "Device" ADD COLUMN "powerLanSubnet" TEXT;
ALTER TABLE "Device" ADD COLUMN "powerMacUpdatedAt" TIMESTAMP(3);

CREATE INDEX "Device_userId_powerLanSubnet_idx" ON "Device"("userId", "powerLanSubnet");
