-- Admin override for SpaceWorker's own exit-node routing (regional SMTP send,
-- private-browser proxy, extraction), independent of premium tier — an admin
-- can revoke a premium user's node access without touching their premium
-- status otherwise (e.g. for abuse).
ALTER TABLE "User" ADD COLUMN "nodeAccessRestricted" BOOLEAN NOT NULL DEFAULT false;
