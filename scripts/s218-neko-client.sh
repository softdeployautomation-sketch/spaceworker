#!/usr/bin/env bash
# TASK_218 B4 — find the neko client assets in-repo and the exact mouse fields it reads.
set -uo pipefail
cd /Users/mikeolab/spaceworker
OUT=scripts/s218-neko-client.out
{
  echo "=== neko asset dirs under public/ ==="
  find public -maxdepth 3 -type d 2>/dev/null | grep -i "browser\|neko" || echo "none"
  echo
  echo "=== any vendored neko js/css ==="
  find public -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" \) 2>/dev/null | grep -i "browser\|neko" | head -20 || echo none
  echo
  echo "=== /browser proxy route(s) ==="
  find app -path "*browser*" -name "route.ts" 2>/dev/null | head -10 || echo none
  grep -rn "browser" app/api --include=route.ts -l 2>/dev/null | grep -i "browser" | head -10 || echo none
  echo
  echo "=== offsetX / clientX usage in lib/touch-controls.ts ==="
  grep -n "offsetX\|offsetY\|clientX\|clientY\|pageX\|screenX" lib/touch-controls.ts
  echo
  echo "=== existing touch-controls tests ==="
  ls tests | grep -i "touch\|208\|212\|216" || echo none
} > "$OUT" 2>&1
echo "WROTE $OUT ($(wc -l < "$OUT") lines)"
