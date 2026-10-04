-- TASK_157 Phase 4 — the domains a USER owns.
--
-- One owner per apex, platform-wide: `apex` is UNIQUE so a domain can never be
-- claimed twice, which is what stops one user taking another's domain (or a
-- platform zone that is not yet on the denylist).
--
-- The ownership boundary is `ownerKind` + `ownerUserId` TOGETHER. Every read path
-- filters on both, never on `ownerKind` alone -- a platform row has a NULL user id.
CREATE TABLE "UserDomain" (
    "id" TEXT NOT NULL,
    "apex" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "ownerKind" TEXT NOT NULL DEFAULT 'user',
    "ownerUserId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'byo',
    "externalRef" TEXT,
    "zoneId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nameservers" TEXT,
    "credentialId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDomain_pkey" PRIMARY KEY ("id")
);

-- Claim-once, enforced by the database so two simultaneous submissions cannot both win.
CREATE UNIQUE INDEX "UserDomain_apex_key" ON "UserDomain"("apex");

-- The per-user listing query: "domains owned by this user, newest first".
CREATE INDEX "UserDomain_ownerKind_ownerUserId_idx" ON "UserDomain"("ownerKind", "ownerUserId");
CREATE INDEX "UserDomain_ownerUserId_status_idx" ON "UserDomain"("ownerUserId", "status");

-- ---------------------------------------------------------------------------
-- Ownership consistency.
--
-- Every read path decides access from `ownerKind` + `ownerUserId` TOGETHER, which
-- only works if the pair is never half-written. Without these constraints a bug (or
-- a hand-written row) could leave ownerKind='user' with a NULL ownerUserId — a row
-- that belongs to nobody yet is readable by nobody and invisible in every admin
-- list, i.e. a domain silently lost — or ownerKind='platform' with a user id set,
-- which is the dangerous direction: it looks platform-owned to some code and
-- user-owned to other, so two different owners could both pass a check.
--
-- These are CHECKs rather than application validation on purpose: the invariant has
-- to hold for admin imports and future scripts too, not just today's code paths.
-- ---------------------------------------------------------------------------

-- A user-owned domain MUST name its owner. A platform domain MUST NOT.
ALTER TABLE "UserDomain"
  ADD CONSTRAINT "UserDomain_owner_consistency_chk"
  CHECK (
    (("ownerKind" = 'user'  AND "ownerUserId" IS NOT NULL) OR
     ("ownerKind" = 'platform' AND "ownerUserId" IS NULL))
  );

-- Only these two kinds exist. Keeps a typo like "Platform"/"user_owned" from
-- creating a row that no access check matches.
ALTER TABLE "UserDomain"
  ADD CONSTRAINT "UserDomain_ownerKind_chk"
  CHECK ("ownerKind" IN ('user', 'platform'));

-- The status set is small and every reader branches on it, so an unknown value
-- would fall through to "treat as not ready" or "treat as ready" depending on the
-- code path. Both outcomes are wrong in different ways, so the DB refuses it.
ALTER TABLE "UserDomain"
  ADD CONSTRAINT "UserDomain_status_chk"
  CHECK ("status" IN ('pending', 'active', 'error'));

-- Source is the seam for the registrar work; constrain it now so a later backfill
-- has something to check against. 'manual' is the admin-assignment path.
ALTER TABLE "UserDomain"
  ADD CONSTRAINT "UserDomain_source_chk"
  CHECK ("source" IN ('byo', 'registrar', 'manual'));

-- A registrable apex is at least "a.b". The full shape (labels, hyphens, TLD) is
-- validated in `isValidDomainApex`; this is only the cheap structural floor that
-- keeps obvious junk (empty string, a bare label, stray whitespace) out of the table
-- even if it arrives from an admin import.
ALTER TABLE "UserDomain"
  ADD CONSTRAINT "UserDomain_apex_chk"
  CHECK (
    "apex" = lower("apex")
    AND "apex" !~ '\s'
    AND length("apex") <= 253
    AND position('.' IN "apex") > 0
  );