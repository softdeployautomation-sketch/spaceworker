#!/usr/bin/env bash
# TASK_209: branch + restore the mailer-exe .vbs allowance (2 files) + consistency greps.
set -eu
cd /Users/mikeolab/spaceworker

echo '=== [1] pre-state ==='
git branch --show-current
git status --short | head -8

echo '=== [2] cut branch off current deployed lineage ==='
git checkout -b agent/task-209-vbs-allow-restore 2>&1

echo '=== [3] restore the two files from mailer-exe ==='
git checkout mailer-exe -- lib/hosting/rules.ts tests/hosting-files.test.ts
git status --short

echo '=== [4] proof: vbs no longer gated; list retained as reference ==='
grep -n 'vbs' lib/hosting/rules.ts | head -4
grep -n 'retired' lib/hosting/rules.ts | head -2

echo '=== [5] any OTHER test asserting downloads are blocked? ==='
grep -rn 'blocked_extension' tests/ | grep -v hosting-files || echo 'none besides hosting-files'

echo '=== [6] who calls scanUpload (no other gate to update) ==='
grep -rn 'scanUpload' app lib --include='*.ts' --include='*.tsx' | grep -v rules.ts | head -6

echo '=== [7] steps BEFORE ==='
cat > TASK_209_VBS_ALLOW_RESTORE_STEPS.md <<'EOF'
# TASK_209 STEPS — .vbs allow-all restore

## BEFORE — 2026-10-15
- Root cause CONFIRMED (see task doc §2): the allowance lived only on `mailer-exe`; my Oct-14 14:25 checkout (mailer-exe -> task-206) rewrote the working-tree rules.ts, and the task-205 deploy shipped the reverted copy to the box (box mtime = the checkout second; rsync -a preserves mtimes).
- Box `scanUpload` (live): `vbs` in BLOCKED_EXTENSIONS -> exact user error string reproduced in source.
- Recovered from `mailer-exe` (committed there, tip 56509b3): rules.ts scanUpload retirement (owner decision 2026-10-14, executables stay GATED, serve route = attachment+nosniff) + 2 hosting-files test updates.
- Grep: no other test asserts blocked downloads; scanUpload called only from the hosting upload path.
- Branch: `agent/task-209-vbs-allow-restore` off `agent/task-207-console-scope` (current deployed lineage).
EOF
echo '--- steps written ---'
wc -l TASK_209_VBS_ALLOW_RESTORE_STEPS.md
