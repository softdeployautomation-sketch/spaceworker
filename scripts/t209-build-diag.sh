#!/usr/bin/env bash
# TASK_209 build-diag: capture the REAL build failure server-side, always restore .next.
set -u
OUT=/tmp/t209-builddiag.txt
{
echo '=== [0] kill the stalled box tsc ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
pkill -f "tsc --noEmit" 2>/dev/null; echo tsc-killed; sleep 1'

echo '=== [1] captured build attempt (full output -> /root/build-diag-209.log) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=30 root@164.68.105.96 '
cd /opt/spaceworker
sudo -u trmm npm run build > /root/build-diag-209.log 2>&1
echo "BUILD_EXIT=$?"
echo "--- error lines ---"
grep -nE "Module not found|Can.t resolve|error TS|Failed to compile" /root/build-diag-209.log | head -20
echo "--- last 12 lines ---"
tail -12 /root/build-diag-209.log'

echo '=== [2] ALWAYS restore the known-good build (safety first) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
cd /opt/spaceworker
rm -rf .next
cp -a /root/.next.LV5-safety .next
echo -n "restored BUILD_ID: "; cat .next/BUILD_ID; echo'

echo '=== [3] pull the full log for analysis ==='
scp -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 \
  root@164.68.105.96:/root/build-diag-209.log /tmp/build-diag-209.log
wc -l /tmp/build-diag-209.log
echo BUILD_DIAG_DONE
} > "$OUT" 2>&1