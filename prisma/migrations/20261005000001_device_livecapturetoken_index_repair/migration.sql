-- BUILD-8 (found 2026-09-26 while fixing TASK_113) — the
-- 20260925000000_task119_live_session_streaming migration created
-- Device_liveCaptureTokenHash_key as a PARTIAL unique index
-- (`WHERE "liveCaptureTokenHash" IS NOT NULL`). The datamodel's plain
-- `@unique` expects a non-partial index of the same name, so `prisma migrate
-- diff` reports drift on it every time even though nothing is actually
-- broken: a plain Postgres unique index already permits unlimited NULLs
-- regardless of a partial WHERE clause, so the two are behaviourally
-- identical for this column. This is a no-op fix for the drift check, not a
-- bug fix for real behavior — no data moved, no rows affected either way.
DROP INDEX "Device_liveCaptureTokenHash_key";
CREATE UNIQUE INDEX "Device_liveCaptureTokenHash_key" ON "Device"("liveCaptureTokenHash");
