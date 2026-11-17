#!/usr/bin/env bash
# Why did box tsc report ../lib/* missing: existence/readability/counts + tsconfig diff
set -u
K="$HOME/.ssh/tacticalrmm_vps"
{
echo '=== [1] key lib files exist on box? ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
for f in agent-visibility device-onboarding agent-approval-token campaign-mailboxes batch-gate-decision; do
  ls -la "/opt/spaceworker/lib/$f.ts" 2>&1 | tail -1
done
echo "--- lib file count (box) ---"
ls /opt/spaceworker/lib/*.ts 2>/dev/null | wc -l
echo "--- can trmm READ one? ---"
sudo -u trmm head -c 40 /opt/spaceworker/lib/agent-visibility.ts >/dev/null 2>&1 && echo trmm-can-read || echo TRMM-CANNOT-READ
echo "--- tests/ dir on box ---"
ls /opt/spaceworker/tests/*.ts 2>/dev/null | wc -l
echo "--- tsconfig include/exclude ---"
grep -E "\"include\"|\"exclude\"|tests" /opt/spaceworker/tsconfig.json | head -6
echo "--- tsc log head (first 5 raw) ---"
head -5 /root/tsc-final.log'
echo '=== [2] local comparison ==='
ls /Users/mikeolab/spaceworker/lib/*.ts 2>/dev/null | wc -l
grep -E "\"include\"|\"exclude\"|tests" /Users/mikeolab/spaceworker/tsconfig.json | head -6
echo CHECK_DONE
} > /tmp/t209-tsccheck.txt 2>&1