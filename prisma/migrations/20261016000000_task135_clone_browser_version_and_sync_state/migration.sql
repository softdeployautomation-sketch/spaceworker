-- TASK_135 — Browser clone: version pin + first-clone/sync state carry
--
-- Two things the clone needed that had nowhere to live:
--
-- 1. THE SOURCE BROWSER'S VERSION. The destination used to be whatever
--    `ghcr.io/m1k1o/neko/chromium:latest` happened to ship against a source that
--    could be any build. That is irrelevant to the cookie carry (cookies move as
--    DATA over CDP) but wrong for the state half — history, tabs, bookmarks,
--    extensions — because Chromium refuses or mangles a profile written by a
--    different version, and extensions are version-sensitive. Storing the source
--    version is what lets the launch pin an equal destination build, and lets the
--    record show what was ACTUALLY delivered rather than what was intended.
--
-- 2. THE LAST ACCEPTED STATE MANIFEST, which is what makes a second and later
--    clone a delta instead of a full re-transfer (first clone vs sync on
--    reconnect). Fingerprints only — path/size/mtime, optionally sha256 — so this
--    adds no secret store; cookie values are never persisted, they travel over
--    CDP and are held in memory only for the launch window.
--
-- Fully additive and nullable: every existing clone behaves exactly as before
-- (NULL sourceBrowserMajor means "undetermined", which the launch refuses BY NAME
-- with a `fresh` fallback rather than guessing at "latest").

-- 1. Source browser identity, as the engine reported it at capture time.
ALTER TABLE "CloneJob" ADD COLUMN "sourceBrowserMajor" INTEGER;
ALTER TABLE "CloneJob" ADD COLUMN "sourceBrowserVersion" TEXT;
ALTER TABLE "CloneJob" ADD COLUMN "sourceBrowserLang" TEXT;

-- 2. The destination build actually delivered (evidence, stamped at launch).
ALTER TABLE "CloneJob" ADD COLUMN "destinationBrowserVersion" TEXT;

-- 3. Delta baseline + the decision taken against it.
ALTER TABLE "CloneJob" ADD COLUMN "stateManifest" JSONB;
ALTER TABLE "CloneJob" ADD COLUMN "stateManifestAt" TIMESTAMP(3);
ALTER TABLE "CloneJob" ADD COLUMN "stateSyncMode" TEXT;
ALTER TABLE "CloneJob" ADD COLUMN "stateSyncReason" TEXT;
