-- Master per-user toggle: "let the agent propose actions at all" (job/campaign
-- pending actions + device action proposals). Default true — opt-out, not a
-- new gate. Chat and manual device tools are unaffected either way.
ALTER TABLE "User" ADD COLUMN "agentActionsEnabled" BOOLEAN NOT NULL DEFAULT true;
