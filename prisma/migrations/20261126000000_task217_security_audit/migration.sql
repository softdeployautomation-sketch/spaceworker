-- TASK_217 — LAN/WiFi audit lab persistence (SecurityAudit + AuditFinding).
-- ADD-TABLE-ONLY by design: bare string ids, no FKs to existing tables, so
-- this migration cannot break unrelated tables and has no dependencies.
-- (Lab-table pattern — see LabConsent / LabAbuseReport.)

-- CreateTable
CREATE TABLE "SecurityAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "consentId" TEXT,
    "verdict" TEXT NOT NULL DEFAULT 'INFO',
    "worstSeverity" TEXT NOT NULL DEFAULT 'none',
    "leakCount" INTEGER NOT NULL DEFAULT 0,
    "passCount" INTEGER NOT NULL DEFAULT 0,
    "infoCount" INTEGER NOT NULL DEFAULT 0,
    "rawJson" JSONB,
    "noData" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "probe" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'none',
    "evidence" TEXT NOT NULL,
    "remediation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityAudit_userId_createdAt_idx" ON "SecurityAudit"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAudit_deviceId_createdAt_idx" ON "SecurityAudit"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditFinding_auditId_idx" ON "AuditFinding"("auditId");

-- CreateIndex
CREATE INDEX "AuditFinding_verdict_idx" ON "AuditFinding"("verdict");
