#!/usr/bin/env bash
set -u
# For each file in the cyberlab deploy list, resolve its @/ and relative imports to
# lib/ or components/ paths, and report which of those targets are STALE or MISSING
# on the box (from the hash diff). Separately flag any that are CLONE files (hold).
SW=/Users/mikeolab/sw-lab
cd "$SW" || exit 1

# stale/missing set from the earlier tree diff
grep -E 'MISSING_ON_BOX|STALE_ON_BOX' /tmp/cyberlab-treediff.log | awk '{print $2}' | LC_ALL=C sort -u > /tmp/box_behind.txt

# collect deploy-list source files (flatten dirs)
DEPLOY=/tmp/cyberlab-files.txt
SRCS=$(mktemp)
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if [ "${line: -1}" = "/" ]; then
    find "${line%/}" -type f \( -name '*.ts' -o -name '*.tsx' \) >> "$SRCS" 2>/dev/null
  else
    case "$line" in *.ts|*.tsx) echo "$line" >> "$SRCS";; esac
  fi
done < "$DEPLOY"
sort -u "$SRCS" -o "$SRCS"

echo "=== deployed source files scanned: $(wc -l < "$SRCS") ==="
echo "=== resolving their imports -> lib/ components targets that are BEHIND on box ==="
NEED=$(mktemp)
while IFS= read -r f; do
  # @/lib/... and @/components/... and relative ./ ../
  grep -oE "from \"(@/[^\"]+|\.\.?/[^\"]+)\"" "$f" 2>/dev/null | sed -E 's/from "//; s/"$//' | while read -r imp; do
    target=""
    case "$imp" in
      @/*) target="${imp#@/}" ;;                # lib/... or components/...
      ./*|../*)
        # resolve relative to the file's dir
        base=$(dirname "$f")
        target=$(cd "$base" 2>/dev/null && realpath -m "$imp" 2>/dev/null)
        target="${target#$SW/}"
        ;;
    esac
    [ -z "$target" ] && continue
    for ext in "" ".ts" ".tsx" "/index.ts" "/index.tsx"; do
      cand="$target$ext"
      if [ -f "$cand" ]; then
        # is it behind on the box?
        if grep -qxF "$cand" /tmp/box_behind.txt; then
          echo "$cand"
        fi
        break
      fi
    done
  done
done < "$SRCS" | sort -u > "$NEED"

echo "--- NON-CLONE deps that are behind on box (candidates to ADD) ---"
grep -vE 'clone|browser-profiles|browser-runtime|hosted-browser' "$NEED" || true
echo "--- CLONE-related deps behind on box (HOLD — must NOT be pulled in) ---"
grep -E 'clone|browser-profiles|browser-runtime|hosted-browser' "$NEED" || echo "(none)"
