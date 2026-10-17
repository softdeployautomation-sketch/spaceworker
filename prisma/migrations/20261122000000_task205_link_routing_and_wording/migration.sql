-- TASK_205 — link routing + owner-editable wording.
-- Part A: owner-editable Desktop-only interstitial copy (desktopTitle, desktopBody).
-- Part B: optional per-platform split (mobileTarget) — one /r/<token> link can send
-- mobile openers to a different destination than desktop openers.
-- All three columns are NULLABLE and ADDITIVE, so every existing LinkRedirect row
-- (including the 12 Task 30 campaign links with userId NULL) keeps resolving
-- unchanged: NULL copy = built-in default wording; NULL mobileTarget = single-target.
-- Alterations only — no table drops, no data touched.

ALTER TABLE "LinkRedirect" ADD COLUMN "desktopTitle" TEXT;
ALTER TABLE "LinkRedirect" ADD COLUMN "desktopBody" TEXT;
ALTER TABLE "LinkRedirect" ADD COLUMN "mobileTarget" TEXT;
