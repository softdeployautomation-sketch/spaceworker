#!/usr/bin/env bash
# TASK_218 A0 — record state before committing TASK_217, and find overlap with 218.
set -uo pipefail
cd /Users/mikeolab/spaceworker
OUT=/Users/mikeolab/spaceworker/scripts/s218-prep.out
{
  echo "=== branch / head ==="
  git branch --show-current
  git rev-parse --short HEAD
  git log -1 --format='%ci %s'
  echo
  echo "=== MODIFIED (tracked) files ==="
  git diff --name-only
  echo
  echo "=== UNTRACKED: task-relevant (TASK_218 may own these) ==="
  git ls-files --others --exclude-standard | grep -E 'TASK_21[0-9]|security-audit|s21[78]|touch-controls|browser-|remote-viewer' || true
  echo
  echo "=== 217 task files present? ==="
  ls -la lib/security-audit/ 2>/dev/null | tail -n +2
  ls -la app/api/security-audit/ 2>/dev/null
  ls -la tests/security-audit-*.test.ts 2>/dev/null
  ls -la prisma/migrations/20261126000000_task217_security_audit/ 2>/dev/null
  echo
  echo "=== 218 target files: current status vs HEAD ==="
  for f in components/browser-popout-view.tsx components/browser-session-panel.tsx \
           components/remote-viewer-controls.tsx components/device-list.tsx \
           lib/touch-controls.ts app/browser-popout/page.tsx \
           "app/browser-popout/[sessionId]/page.tsx"; do
    if [ -e "$f" ]; then
      st=$(git status --porcelain -- "$f")
      echo "$f -> ${st:-clean-vs-HEAD}"
    else
      echo "$f -> MISSING"
    fi
  done
  echo
  echo "=== all branches ==="
  git for-each-ref --format='%(refname:short) %(objectname:short)' refs/heads
  echo
  echo "=== clobber check: 218 targets vs every local head ==="
  git diff --stat HEAD -- components/browser-popout-view.tsx components/browser-session-panel.tsx \
    components/remote-viewer-controls.tsx lib/touch-controls.ts || true
} > "$OUT" 2>&1
echo "WROTE $OUT ($(wc -l < "$OUT") lines)"
