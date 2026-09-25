-- Task 121 (OOB-13, PATH B) — the PUBLIC install artifact.
--
-- The public link /link/vantra/<token> now hands out Vantra's launcher ZIP
-- (the same artifact its own Add-a-device flow produces, with the user's chosen
-- names) instead of the bare agent exe. Minting that ZIP is a secret-bearing
-- generator call on Vantra's side, so the minted result is REMEMBERED on the
-- row: opening a link becomes a redirect, not another generator call
-- (TASK_121 §4a, Q1 decided).
--
--   installerUrl        the raw generator/agent download URL. SERVER-ONLY: read
--                       only by the redirect in resolveInstallToken; never in a
--                       view model, API response, log line or audit row. Not a
--                       new exposure class — the row already stores
--                       privatePsCommand, a complete install command carrying a
--                       token.
--   installerNamesJson  the sanitised { zipName, updateLinkName, innerFolder }
--                       so a re-mint reuses the user's names.
--   installerKind       "zip" | "exe"; NULL = a pre-Task-121 row, which keeps
--                       behaving exactly like today (re-mint on open).
--
-- All three are nullable and unread by old code: rollback is dropping the
-- installer block in mintInstallLink, not this migration.

ALTER TABLE "VantraLink" ADD COLUMN "installerUrl" TEXT;
ALTER TABLE "VantraLink" ADD COLUMN "installerNamesJson" TEXT;
ALTER TABLE "VantraLink" ADD COLUMN "installerKind" TEXT;
