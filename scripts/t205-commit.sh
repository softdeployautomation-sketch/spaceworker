#!/usr/bin/env bash
set -e
cd /Users/mikeolab/spaceworker
git commit -q -F /tmp/task205-msg.txt
echo "=== HEAD ==="
git --no-pager log --oneline -1
echo "=== files in commit ==="
git --no-pager show --stat --format='' HEAD | tail -15
echo "=== working tree (expect only untracked TASK_205 docs + scratch scripts) ==="
git status --short
