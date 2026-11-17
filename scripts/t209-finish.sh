#!/usr/bin/env bash
# TASK_209 finisher: extract build error, restore serving build, pull full log.
set -u
kill -9 16345 3859 3900 2>/dev/null || true
OUT=/tmp/t209-finish.txt
{
echo '=== [A] kill any remote leftover tsc (self-match-safe pattern) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "pkill -f 'tsc --no[E]mit' 2>/dev/null; echo rc=\$? || true"

echo '=== [B] the definitive build error ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
grep -nE "Module not found|Can.t resolve|error TS|Failed to compile|Type error" /root/build-diag-209.log | head -20
echo "--- context around first error ---"
FIRST=$(grep -nE "Module not found|Can.t resolve|error TS|Type error" /root/build-diag-209.log | head -1 | cut -d: -f1)
if [ -n "$FIRST" ]; then sed -n "$((FIRST-8)),$((FIRST+12))p" /root/build-diag-209.log; fi
echo "--- last 6 lines ---"
tail -6 /root/build-diag-209.log'

echo '=== [C] restore the known-good build ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
cd /opt/spaceworker && rm -rf .next && cp -a /root/.next.LV5-safety .next
echo -n "BUILD_ID: "; cat .next/BUILD_ID; echo
systemctl is-active spaceworker
curl -s -o /dev/null -w "localhost:3500 -> %{http_code}\n" -m 15 http://localhost:3500/'

echo '=== [D] pull full log ==='
scp -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 \
  root@164.68.105.96:/root/build-diag-209.log /tmp/build-diag-209.log && wc -l /tmp/build-diag-209.log
echo FINISH_DONE
} > "$OUT" 2>&1