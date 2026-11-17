#!/usr/bin/env bash
# TASK cyberlab deploy PREFLIGHT — gather everything before touching the box.
cd /Users/mikeolab/sw-lab
echo "=== 1. EXACT cyberlab file list (origin/main..3765ab4, i.e. up to UI-1, EXCLUDING the a4d3621 docs commit and the 3e641ba clone fix) ==="
git diff --name-only origin/main..3765ab4
echo
echo "=== 2. Files touched by the clone-fix commit 3e641ba (MUST exclude) ==="
git show --stat --format='' 3e641ba | head -20
echo
echo "=== 3. Is sw-lab working tree clean? (must be yes before rsync) ==="
git status --short | head -20
echo "(end status)"
echo
echo "=== 4. Do any cyberlab files import clone-browsers or other risky siblings? ==="
for f in $(git diff --name-only origin/main..3765ab4 | grep -E '\.(ts|tsx)$'); do
  if [ -f "$f" ]; then
    grep -Hn 'clone-browsers\|from "\./clone' "$f" 2>/dev/null
  fi
done
echo "(end import scan)"
echo "=== DONE ==="
