#!/usr/bin/env bash
# TASK_209 diag: deploy script's build/promote/restart logic + box .next state.
set -u
OUT=/tmp/t209-diag2.txt
{
echo '=== [1] deploy-vps.sh: lines mentioning build/promote/rollback/BUILD_ID ==='
grep -n 'BUILD_ID\|next build\|rollback\|\.next\.\|\.next_bak\|mv \|cp -a\|last-good' /Users/mikeolab/spaceworker/scripts/deploy-vps.sh | head -40

echo '=== [2] box .next dirs + BUILD_ID stat ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
ls -lad /opt/spaceworker/.next* 2>/dev/null
stat -c "%y %n" /opt/spaceworker/.next/BUILD_ID 2>/dev/null
echo -n "BUILD_ID content: "; cat /opt/spaceworker/.next/BUILD_ID 2>/dev/null; echo
ls -la /root/*.log 2>/dev/null | head -6
echo "--- rules.ts on box: vbs gated or retired? ---"
grep -n "gate is retired" /opt/spaceworker/lib/hosting/rules.ts | head -2 || echo "NOT retired (old copy)"
'
echo DIAG2_DONE
} > "$OUT" 2>&1