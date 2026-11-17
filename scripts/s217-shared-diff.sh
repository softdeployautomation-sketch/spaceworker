#!/usr/bin/env bash
# TASK_217 STEPS BEFORE — clobber-rule check (PROMPT_TASK_AGENT §3.1): diff every
# file this task may touch against EVERY local branch (heads + remotes). Output
# goes to a file; nothing is checked out or modified.
set -u
cd "$(dirname "$0")/.." || exit 1

FILES=(
  "components/device-console.tsx"
  "prisma/schema.prisma"
  "lib/device-tools.ts"
  "lib/vantra-link.ts"
)

OUT="scripts/s217-shared-diff.out"
: > "$OUT"

BRANCHES=$(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes)

for f in "${FILES[@]}"; do
  echo "=== $f ===" >> "$OUT"
  for b in $BRANCHES; do
    [ "$b" = "main" ] && continue
    git cat-file -e "$b:$f" 2>/dev/null || { echo "  $b: (absent)" >> "$OUT"; continue; }
    if git diff --quiet main "$b" -- "$f" 2>/dev/null; then
      echo "  $b: same as main" >> "$OUT"
    else
      echo "  $b: DIFFERS  ($(git diff --numstat main "$b" -- "$f" | awk '{print "+"$1" -"$2}'))" >> "$OUT"
    fi
  done
done

echo "=== migration dirs newest per ref (must be < 20261126000000) ===" >> "$OUT"
for b in $BRANCHES; do
  last=$(git ls-tree -r --name-only "$b" prisma/migrations 2>/dev/null \
    | grep -E 'prisma/migrations/2026[0-9]{10}_' | sed 's|prisma/migrations/||' | cut -d/ -f1 | sort | tail -1)
  [ -n "$last" ] && echo "  $b: $last" >> "$OUT"
done

echo "DONE" >> "$OUT"
