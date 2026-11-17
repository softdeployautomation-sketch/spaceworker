#!/usr/bin/env bash
# TASK_218 B3 — where does the owner reach a private-browser/neko stream from?
set -uo pipefail
cd /Users/mikeolab/spaceworker
OUT=scripts/s218-paths.out
{
  echo "=== BrowserSessionPanel consumers ==="
  grep -rn "BrowserSessionPanel" --include=*.tsx app components 2>/dev/null | grep -v "^components/browser-session-panel.tsx" || echo none
  echo
  echo "=== device-console.tsx: browser-session / neko / clone-session references ==="
  grep -n "browser-session-panel\|BrowserSessionPanel\|clone-session-view\|CloneSessionView\|browser-session" components/device-console.tsx || echo none
  echo
  echo "=== device-list.tsx: any browser/neko/popout opener ==="
  grep -n "browser\|neko\|popout\|_blank\|window.open" components/device-list.tsx || echo none
  echo
  echo "=== clone-session-view.tsx head (imports + what it renders) ==="
  sed -n '1,30p' components/clone-session-view.tsx
  echo
  echo "=== /dashboard/browser page ==="
  find app/dashboard -path '*browser*' -name 'page.tsx' 2>/dev/null || echo none
} > "$OUT" 2>&1
echo "WROTE $OUT ($(wc -l < "$OUT") lines)"
