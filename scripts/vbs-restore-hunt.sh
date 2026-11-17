#!/usr/bin/env bash
# Confirm the .vbs allowance lives on mailer-exe and is recoverable.
set -u
OUT=/tmp/vbs-restore-hunt.txt
{
echo '=== [1] mailer-exe branch exists? ==='
cd /Users/mikeolab/spaceworker || exit 1
git branch -a --list '*mailer*'
git log --oneline -3 mailer-exe 2>/dev/null || echo 'NO mailer-exe branch — last known sha 56509b3'

echo '=== [2] rules.ts history (all refs) ==='
git log --all --oneline --date=short --format='%h %ad %s' -- lib/hosting/rules.ts | head -8

echo '=== [3] does mailer-exe (or 56509b3) rules.ts differ from HEAD? ==='
git diff HEAD mailer-exe -- lib/hosting/rules.ts 2>/dev/null | head -40 || \
git diff HEAD 56509b3 -- lib/hosting/rules.ts 2>/dev/null | head -40 || echo 'neither ref resolves'

echo '=== [4] vbs in BLOCKED_EXTENSIONS on mailer-exe? ==='
git show mailer-exe:lib/hosting/rules.ts 2>/dev/null | grep -n 'vbs' | head -5 || \
git show 56509b3:lib/hosting/rules.ts 2>/dev/null | grep -n 'vbs' | head -5 || echo 'ref not found'

echo '=== [5] any other branch with rules.ts differing from origin/main? ==='
for b in $(git for-each-ref --format='%(refname:short)' refs/heads); do
  if ! git diff --quiet origin/main "$b" -- lib/hosting/rules.ts 2>/dev/null; then
    echo "DIFFERS: $b"
  fi
done

echo '=== [6] what did mailer-exe branch change overall (files)? ==='
git diff --stat origin/main mailer-exe 2>/dev/null | tail -12 || echo 'no mailer-exe ref'

echo '=== [7] reflog: full mailer-exe window yesterday ==='
git reflog --date=iso 2>/dev/null | grep -i 'mailer' | head -8
echo DONE
} > "$OUT" 2>&1
echo WROTE
