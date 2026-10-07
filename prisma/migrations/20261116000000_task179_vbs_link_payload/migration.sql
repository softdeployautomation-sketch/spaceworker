-- TASK_179 stage 2 — the public `.vbs` link's payload column.
--
-- The shareable VBS link (same /link/vantra/<token> wrapper + history table
-- as zip/exe links) stores the two things a resolve-time render needs and
-- cannot regenerate: the guide PDF the user picked (base64, capped at 2 MB
-- by the mint — row-bloat bound, TASK_179 D3) and the file name to serve.
-- The install COMMAND is deliberately NOT stored: resolveVbsInstallToken
-- regenerates it from Vantra on every open (D5 — a delivered file never
-- carries a stored/stale credential).
--
--   installerPayloadJson  SERVER-ONLY, same exposure class as the existing
--                         installerUrl / installerNamesJson columns: read
--                         only by the vbs resolver, never in a view/response/
--                         log/audit row.
--
-- Additive-only: one nullable column, no existing row rewritten.

ALTER TABLE "VantraInstallLink" ADD COLUMN "installerPayloadJson" TEXT;