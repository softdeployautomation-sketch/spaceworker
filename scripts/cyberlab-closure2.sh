#!/usr/bin/env bash
set -u
# Second-level closure: the 4 newly-added files (auth/db/prisma/products) may import
# more box-stale files. Resolve THEIR imports too, transitively (bounded), excluding clone.
SW=/Users/mikeolab/sw-lab
cd "$SW" || exit 1
grep -E 'MISSING_ON_BOX|STALE_ON_BOX' /tmp/cyberlab-treediff.log | awk '{print $2}' | LC_ALL=C sort -u > /tmp/box_behind.txt

resolve_imports () {
  local f="$1"
  grep -oE "from \"(@/[^\"]+|\.\.?/[^\"]+)\"" "$f" 2>/dev/null | sed -E 's/from "//; s/"$//' | while read -r imp; do
    target=""
    case "$imp" in
      @/*) target="${imp#@/}" ;;
      ./*|../*)
        base=$(dirname "$f")
        target=$(cd "$base" 2>/dev/null && realpath -m "$imp" 2>/dev/null); target="${target#$SW/}" ;;
    esac
    [ -z "$target" ] && continue
    for ext in "" ".ts" ".tsx" "/index.ts" "/index.tsx"; do
      [ -f "$target$ext" ] && { echo "$target$ext"; break; }
    done
  done
}

# BFS over the 4 seed files, up to depth 4, collecting box-behind targets
SEEDS="lib/auth.ts lib/db.ts lib/prisma.ts lib/products.ts"
ALL=$(mktemp); QUEUE=$(mktemp)
echo "$SEEDS" | tr ' ' '\n' > "$QUEUE"
depth=0
while [ $depth -lt 4 ]; do
  NEXT=$(mktemp)
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    echo "$f" >> "$ALL"
    resolve_imports "$f"
  done < "$QUEUE" | sort -u | while read -r t; do
    [ -f "$t" ] || continue
    grep -qxF "$t" "$ALL" && continue
    echo "$t"
  done | sort -u > "$NEXT"
  [ -s "$NEXT" ] || break
  cp "$NEXT" "$QUEUE"
  depth=$((depth+1))
done

echo "=== full transitive set touched by the 4 seeds (exists locally) ==="
sort -u "$ALL" | grep -vE '^$' > /tmp/cyberlab_seedclosure.txt
cat /tmp/cyberlab_seedclosure.txt
echo
echo "=== of those, which are BEHIND on the box? ==="
comm -12 /tmp/cyberlab_seedclosure.txt /tmp/box_behind.txt > /tmp/cyberlab_seedbehind.txt
cat /tmp/cyberlab_seedbehind.txt
echo
echo "=== of THOSE, any CLONE? (must be empty) ==="
grep -E 'clone|browser-profiles|browser-runtime|hosted-browser' /tmp/cyberlab_seedbehind.txt && echo "!!! CLONE PRESENT — STOP" || echo "(no clone — safe)"
