#!/usr/bin/env bash
set -u
cd /Users/mikeolab/spaceworker
set -e
# Stash ONLY the 2 modified clone-resync files so they survive the branch cut untouched.
git stash push -m 'task135-clone-resync-wip' -- components/device-console.tsx scripts/deploy-vps.sh
git fetch origin -q || true
git checkout -b agent/task-208-neko-mobile origin/main
git stash pop
echo '=== BRANCH ==='
git branch --show-current
echo '=== STATUS (expect: 2 M clone-resync files + untracked TASK docs/scripts/208 files) ==='
git status --short | head -12
echo '=== 208 files present ==='
test -f lib/touch-controls.ts && test -f tests/agent-touch-controls.test.ts && echo OK_208_FILES
echo '=== clone-resync mods restored ==='
git diff --stat -- components/device-console.tsx scripts/deploy-vps.sh
