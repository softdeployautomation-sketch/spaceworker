-- TASK_155 P6c — the LINKS engine.
--
-- Strictly ADDITIVE. Every existing column keeps its default, so all 12 Task 30
-- campaign links (userId NULL) come back as engine 'local' and /r/<token>
-- resolves them exactly as before. Deliberately touches LinkRedirect ONLY —
-- HostedAsset gains no engine column, because Files stay on local/instaweb.
ALTER TABLE "LinkRedirect" ADD COLUMN "engine"       TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "LinkRedirect" ADD COLUMN "credentialId" TEXT;
ALTER TABLE "LinkRedirect" ADD COLUMN "workerName"   TEXT;
ALTER TABLE "LinkRedirect" ADD COLUMN "routePattern" TEXT;
ALTER TABLE "LinkRedirect" ADD COLUMN "customHost"   TEXT;
ALTER TABLE "LinkRedirect" ADD COLUMN "deployStatus" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "LinkRedirect" ADD COLUMN "deployError"  TEXT;

CREATE INDEX "LinkRedirect_engine_idx" ON "LinkRedirect" ("engine");