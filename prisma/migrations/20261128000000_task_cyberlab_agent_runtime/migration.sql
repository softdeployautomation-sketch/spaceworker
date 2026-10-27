-- Cyber Lab Agent Runtime — Cline Core SDK (PLAN_CYBERLAB_AGENT_RUNTIME.md)
-- Additive only: new tables, no existing table modified.

CREATE TABLE "CyberLabAgentSettings" (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"           TEXT NOT NULL UNIQUE,
  "clineApiKeyEnc"   TEXT,
  "clineOAuthTokenEnc" TEXT,
  "clineRefreshTokenEnc" TEXT,
  "clineModelId"     TEXT,
  "clineApiEndpoint" TEXT,
  "updatedAt"        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "CyberLabAgentSession" (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"         TEXT NOT NULL,
  "companyId"      TEXT,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "modelProvider"  TEXT NOT NULL DEFAULT 'cline',
  "modelId"        TEXT NOT NULL,
  "apiEndpoint"    TEXT,
  "apiKeyHash"     TEXT,
  "cwd"            TEXT,
  "startedAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastActivityAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "idleShutdownAt" TIMESTAMPTZ,
  "contextDocPath" TEXT,
  "stopReason"     TEXT,
  "frozenByAdmin"  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE "CyberLabContextDocStep" (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "sessionId"      TEXT NOT NULL,
  "stepNo"         INTEGER NOT NULL,
  "modelProvider"  TEXT NOT NULL,
  "modelId"        TEXT NOT NULL,
  "apiEndpoint"    TEXT,
  "summary"        TEXT NOT NULL,
  "contentRef"     TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "CyberLabKillSwitch" (
  id        TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "scope"     TEXT NOT NULL DEFAULT 'global',
  "targetId"  TEXT,
  "frozen"    BOOLEAN NOT NULL DEFAULT false,
  "reason"    TEXT,
  "setBy"     TEXT NOT NULL,
  "setAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "CyberLabAgentSettings_userId_idx" ON "CyberLabAgentSettings"("userId");
CREATE INDEX "CyberLabAgentSession_userId_status_idx" ON "CyberLabAgentSession"("userId", "status");
CREATE INDEX "CyberLabAgentSession_companyId_idx" ON "CyberLabAgentSession"("companyId");
CREATE INDEX "CyberLabContextDocStep_sessionId_stepNo_idx" ON "CyberLabContextDocStep"("sessionId", "stepNo");
CREATE INDEX "CyberLabKillSwitch_scope_targetId_idx" ON "CyberLabKillSwitch"("scope", "targetId");