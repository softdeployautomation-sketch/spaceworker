#!/usr/bin/env bash
# TASK_209 watcher: wait for the deploy to finish (max 12 min), then verify everything.
set -u
OUT=/tmp/t209-final.txt
{
for i in $(seq 1 36); do
  if ! pgrep -f 'deploy-vps.sh' >/dev/null 2>&1; then
    echo "=== deploy finished after ~$((i*20))s ==="
    break
  fi
  sleep 20
done
pgrep -f 'deploy-vps.sh' >/dev/null 2>&1 && echo '=== STILL RUNNING after 12min — investigate ==='

echo '=== local deploy log tail ==='
tail -25 /tmp/t209-deploy.log 2>/dev/null || echo 'no local log'

echo '=== VERIFY ==='
bash /Users/mikeolab/spaceworker/scripts/t209-verify.sh 2>&1

echo '=== journal failure markers (last 15 min) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
journalctl -u spaceworker --since "-15min" --no-pager 2>/dev/null | grep -iE "error|failed|Module not found|Can.t resolve" | tail -8 || echo none'
echo WATCHER_DONE
} > "$OUT" 2>&1
