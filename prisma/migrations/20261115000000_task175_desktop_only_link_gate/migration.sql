-- TASK_175 — Desktop-only gate for hosting short links (premium-only).
--
-- A per-link opt-in flag: when ON, a mobile/tablet opener of /r/<key> sees a
-- small "open this on your PC" interstitial instead of the redirect; desktop
-- openers pass straight through. Premium-only (the flag is only ever SET for
-- premium minters — enforced in lib/hosting/links.ts, not here).
--
-- Additive-only: one NULLABLE column, default NULL (= today's behavior).
-- Existing rows read back as "gate off" with zero behavior change.

ALTER TABLE "LinkRedirect" ADD COLUMN "desktopOnly" BOOLEAN;
