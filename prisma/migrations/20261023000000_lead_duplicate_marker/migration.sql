-- TASK_150 T2 — repeated emails across extraction sessions are MARKED, never
-- deleted, and never conflated with an MX failure.
--
-- Root cause this migration serves: Lead's uniqueness is PER JOB
-- (@@unique([searchJobId, sourceUrl, email])), so two sessions (two SearchJob
-- rows) store the same address twice and POST /api/jobs/[id]/validate — which
-- only ever looks at `validationStatus: "unchecked"` leads of ITS OWN job — can
-- never see the earlier session's copy. Dedupe must therefore be scoped
-- [userId, email], which is what the new index backs.
--
-- Both statements are ADDITIVE and nullable-safe: every existing row gets
-- duplicateOfId = NULL (its default meaning: "not a duplicate"), and no
-- validationStatus value is rewritten by this migration. In particular nothing
-- is moved into the new "duplicate" value here — that happens at persist /
-- validate time via lib/lead-duplicates.ts, on the user's own data, observably.
ALTER TABLE "Lead" ADD COLUMN "duplicateOfId" TEXT;

-- Serves the case-insensitive, per-user lookup. The query itself is
-- lower(btrim(email)), which this plain index cannot serve as a whole, but it
-- still bounds the scan to one user's leads, which is the point (the previous
-- access path was [userId, searchJobId] — per JOB, i.e. exactly the bug).
CREATE INDEX "Lead_userId_email_idx" ON "Lead"("userId", "email");
