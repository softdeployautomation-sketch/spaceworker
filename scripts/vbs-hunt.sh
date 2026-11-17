#!/usr/bin/env bash
# Find the "allow all files" task from yesterday and what reverted it.
set -u
OUT=/tmp/vbs-hunt.txt
{
echo '=== [1] task docs mentioning vbs / allow-all ==='
grep -li 'vbs\|allow all\|all file types\|any file type' /Users/mikeolab/spaceworker/TASK_*.md /Users/mikeolab/sw-lab/TASK_*.md 2>/dev/null

echo '=== [2] all commits since Oct 13 touching hosting surfaces (any branch) ==='
cd /Users/mikeolab/spaceworker || exit 1
git log --all --since='2026-10-13' --oneline --date=short --format='%h %ad %s' -- lib/hosting app/api/hosting components/hosting-panel.tsx | head -20

echo '=== [3] same search in sw-lab ==='
cd /Users/mikeolab/sw-lab && git log --all --since='2026-10-13' --oneline --format='%h %ad %s' -- lib/hosting app/api/hosting 2>/dev/null | head -10

echo '=== [4] uncommitted/unstaged traces in spaceworker: reflog checkout events yesterday ==='
cd /Users/mikeolab/spaceworker || exit 1
git reflog --date=iso 2>/dev/null | grep '2026-10-14' | head -15

echo '=== [5] box: mtimes of ALL hosting lib + api files (revert = newer mtime than 15:25 task205) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
find /opt/spaceworker/lib/hosting /opt/spaceworker/app/api/hosting -type f -newermt "2026-10-13" -exec stat -c "%y %n" {} \; 2>/dev/null | sort'

echo '=== [6] box rules.ts around the gate (240-300) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 'sed -n "236,300p" /opt/spaceworker/lib/hosting/rules.ts'
echo DONE
} > "$OUT" 2>&1
echo WROTE
