#!/usr/bin/env bash
set -euo pipefail
cd /Users/mikeolab/spaceworker
OUT=/tmp/task205-anchors2.txt
: > "$OUT"
{
echo "===== schema: model LinkRedirect ====="
awk '/model LinkRedirect /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma
echo; echo "===== hosting-panel.tsx: desktop-only UI lines ====="
grep -n 'desktopOnly\|Desktop only\|Desktop-only\|desktopOnlyAllowed\|Edit wording\|Split by device\|mobileTarget' components/hosting-panel.tsx
echo; echo "===== hosting-panel.tsx total lines ====="
wc -l < components/hosting-panel.tsx
echo; echo "===== existing link/worker tests ====="
ls tests/ | grep -iE 'hosting|link|worker|desktop|redirect' || echo '(none)'
} >> "$OUT" 2>&1
echo WROTE "$OUT"
