#!/usr/bin/env bash
# TASK_218 B2 — is the CLONE "Open" path (device-console.tsx:1582 data.openUrl)
# a bare-neko-URL opener (H7), i.e. no SpaceWorker chrome?
set -uo pipefail
cd /Users/mikeolab/spaceworker
OUT=scripts/s218-clone-openurl.out
{
  echo "=== /api/clones session routes ==="
  find app/api/clones -name route.ts | sort
  echo
  echo "=== openUrl occurrences ==="
  grep -rn "openUrl" --include=*.ts --include=*.tsx app lib components 2>/dev/null | grep -v node_modules || echo none
  echo
  echo "=== clone-hosted-launch: viewUrl / connectUrlFor ==="
  grep -n "viewUrl\|connectUrlFor\|openUrl" lib/clone-hosted-launch.ts
  echo
  echo "=== /clone pages + viewUrl consumers ==="
  find app/clone -name "page.tsx" 2>/dev/null || echo "no app/clone pages"
  grep -rn "viewUrl" app --include=*.tsx --include=*.ts 2>/dev/null | head -20 || echo none
} > "$OUT" 2>&1
echo "WROTE $OUT ($(wc -l < "$OUT") lines)"
