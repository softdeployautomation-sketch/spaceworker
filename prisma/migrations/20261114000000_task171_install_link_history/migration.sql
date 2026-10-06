-- TASK_171 — public install-link history: one row per mint.
--
-- Minting a new public link used to OVERWRITE the VantraLink row
-- (installTokenHash / installTokenExpiresAt / installUrl / installerUrl), so
-- every "New link" destroyed the previous one and there was no download
-- counter anywhere. Each mint now ALSO writes one row here; the VantraLink
-- row is untouched by this migration and stays the CURRENT-link pointer.
--
--   tokenHash    UNIQUE sha256(token) — hash-only, raw tokens never hit the DB.
--   installerUrl SERVER-ONLY raw generator/agent URL (same class as the
--                VantraLink column): read only by the resolve redirect, never
--                serialised. Per-mint so an OLD link opens the artifact minted
--                for THAT token instead of triggering a re-mint.
--   downloadCount starts 0, +1 per successful open (best-effort increment).
--
-- Additive-only: a new table, no existing row rewritten. Revoke deletes
-- nothing (revoked users resolve/list nothing via the VantraLink status).

CREATE TABLE "VantraInstallLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "installerUrl" TEXT,
    "installerKind" TEXT,
    "installerNamesJson" TEXT,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VantraInstallLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VantraInstallLink_tokenHash_key" ON "VantraInstallLink"("tokenHash");
CREATE INDEX "VantraInstallLink_userId_createdAt_idx" ON "VantraInstallLink"("userId", "createdAt");

ALTER TABLE "VantraInstallLink" ADD CONSTRAINT "VantraInstallLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
