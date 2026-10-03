-- TASK_155 P6c (PLAN §19.12) — the Workers/DNS token, as a SECOND credential.
--
-- Purely ADDITIVE and NULLABLE: every existing row keeps working untouched, and
-- a NULL worker token simply means "this row publishes Pages only", so the link
-- engine stays on its local /r/<token> fallback. Nothing here rewrites a row,
-- and no column is NOT NULL, so this is safe to apply to a live database.
--
--   * HostingCredential.workerToken* — a BYO user's own Workers/DNS token, so a
--     user can use their Cloudflare for LINK redirects as well as for Pages.
--   * HostingPlatformAccount.workerToken* — the platform's (owner's) Workers/DNS
--     token, replaceable from the admin panel at any time without touching the
--     Pages rotation.
--
-- The Pages token is scoped to Pages and CANNOT upload a Worker script, which is
-- why this is a separate token rather than a widened one. Both are AES-256-GCM
-- encrypted with the same MAILBOX_ENCRYPTION_KEY helpers, never plaintext, and
-- never returned by any route — the views expose only `workerTokenHint`.

-- AlterTable
ALTER TABLE "HostingCredential" ADD COLUMN "workerTokenCiphertext" TEXT,
ADD COLUMN "workerTokenIv" TEXT,
ADD COLUMN "workerTokenTag" TEXT,
ADD COLUMN "workerTokenHint" TEXT NOT NULL DEFAULT '',
ADD COLUMN "workerTokenError" TEXT;

-- AlterTable
ALTER TABLE "HostingPlatformAccount" ADD COLUMN "workerTokenCiphertext" TEXT,
ADD COLUMN "workerTokenIv" TEXT,
ADD COLUMN "workerTokenTag" TEXT,
ADD COLUMN "workerTokenHint" TEXT NOT NULL DEFAULT '',
ADD COLUMN "workerTokenError" TEXT;