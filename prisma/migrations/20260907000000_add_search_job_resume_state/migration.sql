-- Task 13 resumable jobs: a paused SearchJob needs to persist enough state to
-- resume from the next unprocessed query instead of restarting. Nullable and
-- additive — only populated while a job is paused; cleared on resume.
ALTER TABLE "SearchJob" ADD COLUMN "resumeState" JSONB;