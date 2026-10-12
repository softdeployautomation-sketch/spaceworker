-- TASK_135 §3/§5 (second half) — the two NAMED reasons a clone did not get what
-- it asked for.
--
-- The version pin and the state carry both have a deliberate fallback: when the
-- source build cannot be delivered, the clone still runs (the cookie half does
-- not depend on the build) but the user's files must NOT be written into a
-- profile a different build will open. That fallback is only defensible if it is
-- visible — "the clone worked but my history is missing" is otherwise
-- indistinguishable from a bug, and there is nowhere on the record to look.
--
--   browserPinError   — the named refusal from the pin/resolver
--                       (browser_version_unknown, pinned_build_download_failed,
--                       pinned_browser_unavailable: ...).
--   stateRestoreNote   — why the staged state was not materialised
--                       (state_skipped_no_matching_build, state_profile_unknown),
--                       or null when it was.
--
-- Additive and nullable: every existing job row and every existing code path is
-- unchanged by this migration.

ALTER TABLE "CloneJob" ADD COLUMN "browserPinError" TEXT;
ALTER TABLE "CloneJob" ADD COLUMN "stateRestoreNote" TEXT;
