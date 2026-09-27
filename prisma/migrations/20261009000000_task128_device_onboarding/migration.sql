-- TASK_128 — device onboarding quarantine ("one process at a time").
--
-- Everything below is ADDITIVE and changes NO existing behaviour: every
-- existing Device defaults to tier = 'public', and no DeviceOnboarding row
-- exists until a device is next synced through lib/vantra-link.ts syncDevices()
-- (which stamps the tier and opens the row). The public→private move itself is
-- unchanged and still Vantra's (lib/device-auto-move.ts) — this only records the
-- SpaceWorker-side hide@5 / stay-on@10 stages and the release.
--
-- Column order matches the datamodel (and `prisma migrate diff` output), so the
-- file stays reproducible from schema.prisma.

-- Which org the agent was last listed under — "public" until the Vantra
-- auto-move lands, "private" after. DEFAULT 'public' backfills every existing
-- row in place, so nothing needs to be rewritten before the next sync.
ALTER TABLE "Device"
  ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'public';

CREATE TABLE "DeviceOnboarding" (
  "id" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "vantraAgentId" TEXT NOT NULL,
  "sourceOrgId" TEXT NOT NULL,
  "destinationOrgId" TEXT,
  -- Copied from Vantra's DeviceAutoMove.timerStartedAt — the ONE clock the UI
  -- countdown and the actual move share.
  "timerStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hideLabel" TEXT,
  "hideDoneAt" TIMESTAMP(3),
  "hideOutput" TEXT,
  "stayOnDoneAt" TIMESTAMP(3),
  "movedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  -- "pending" | "hiding" | "staying_on" | "moving" | "released" | "failed".
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  -- Diagnostic only — never a staleness gate (see lib/device-onboarding.ts).
  "claimAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DeviceOnboarding_pkey" PRIMARY KEY ("id")
);

-- One row per device: findUnique / upsert by deviceId is the whole access path.
CREATE UNIQUE INDEX "DeviceOnboarding_deviceId_key" ON "DeviceOnboarding"("deviceId");
-- Read paths that actually exist: the sweep's non-terminal scan, and a user's
-- onboarding rows for the strip/badge.
CREATE INDEX "DeviceOnboarding_status_idx" ON "DeviceOnboarding"("status");
CREATE INDEX "DeviceOnboarding_userId_status_idx" ON "DeviceOnboarding"("userId", "status");

-- Cascade, matching DeviceScreenshot's reasoning: an onboarding row for a
-- deleted device (or account) has nothing to preserve.
ALTER TABLE "DeviceOnboarding"
  ADD CONSTRAINT "DeviceOnboarding_deviceId_fkey" FOREIGN KEY ("deviceId")
  REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeviceOnboarding"
  ADD CONSTRAINT "DeviceOnboarding_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
