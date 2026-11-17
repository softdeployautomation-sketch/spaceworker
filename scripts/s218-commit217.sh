#!/usr/bin/env bash
# TASK_218 A1 — commit completed TASK_217 as ONE commit on agent/task-217-lan-audit,
# then record the 218-target clobber diff against every local head.
set -euo pipefail
cd /Users/mikeolab/spaceworker
OUT=/Users/mikeolab/spaceworker/scripts/s218-commit217.out
{
  echo "=== branch ==="
  git branch --show-current   # must be agent/task-217-lan-audit

  echo "=== stage ONLY 217 code files ==="
  git add components/device-console.tsx package.json prisma/schema.prisma
  git add lib/security-audit app/api/security-audit tests/security-audit-judge.test.ts tests/security-audit-scope.test.ts
  git add prisma/migrations/20261126000000_task217_security_audit

  echo "=== staged (must contain no TASK_*.md / scripts/ / s217-shared-diff) ==="
  git diff --cached --name-only

  echo "=== commit ==="
  git commit -q -m "TASK_217 (task agent): LAN/WiFi audit lab — probe pack (lib/security-audit/probes.ts), judging service + key scrub, SecurityAudit/AuditFinding tables, security-audit routes, CommandTab NetworkAuditCard, 34 tests. Uncommitted-at-handoff rule lifted per senior instruction." || echo "COMMIT_FAILED"
  echo "=== new HEAD ==="
  git log -1 --format='%h %s'
  echo
  echo "=== status after (217 task files must be gone; step-docs still untracked) ==="
  git status --porcelain | grep -E 'security-audit|TASK_217|schema.prisma|device-console|^ M package.json' || echo "(none — clean)"
} > "$OUT" 2>&1
echo "WROTE $OUT"
