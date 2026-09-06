-- Task 14 live activity feed: the current crawler step as a short text line
-- ("Searching: ...", "Visiting page N of Google results", "Reading a PDF at ...").
-- Nullable and additive — only populated by the dispatcher's per-tick poll while
-- the job is running; deliberately NOT cleared on done/paused/failed so the last
-- known step stays visible after the job stops.
ALTER TABLE "SearchJob" ADD COLUMN "currentStep" TEXT;