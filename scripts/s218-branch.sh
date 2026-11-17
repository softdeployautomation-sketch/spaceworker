#!/usr/bin/env bash
# TASK_218 A2 — cut agent/task-218-mobile-neko-mouse from LOCAL MAIN (per task doc).
set -euo pipefail
cd /Users/mikeolab/spaceworker
OUT=/Users/mikeolab/spaceworker/scripts/s218-branch.out
{
  echo "=== NOTE: main is checked out by worktree /Users/mikeolab/sw-vbsfix ==="
  echo "=== so 'git checkout main' is forbidden; cut 218 branch FROM the main ref instead ==="
  git rev-parse --short main   # expect 16bd2df
  echo
  echo "=== cut 218 branch from main ref (no checkout of main itself) ==="
  git checkout -b agent/task-218-mobile-neko-mouse main
  git branch --show-current
  git log -1 --format='%h %s'
  echo
  echo "=== confirm base == main (16bd2df), NOT 217 ==="
  [ "$(git rev-parse HEAD)" = "$(git rev-parse main)" ] && echo "BASE == main (GOOD)" || echo "BASE != main (BAD)"
  echo
  echo "=== 217 still intact + unmerged? ==="
  git log agent/task-217-lan-audit -1 --format='%h %s'
  git merge-base --is-ancestor agent/task-217-lan-audit main && echo "217 IS in main (BAD)" || echo "217 NOT merged into main (GOOD)"
  echo
  echo "=== 218 target files exist on this base? ==="
  for f in components/browser-popout-view.tsx components/browser-session-panel.tsx \
           components/remote-viewer-controls.tsx lib/touch-controls.ts \
           "app/browser-popout/[sessionId]/page.tsx"; do
    if [ -e "$f" ]; then echo "OK   $f ($(wc -l < "$f") lines)"; else echo "MISS $f"; fi
  done
} > "$OUT" 2>&1
echo "WROTE $OUT"
