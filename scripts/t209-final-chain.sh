#!/usr/bin/env bash
# TASK_209 final chain: box tsc -> (if clean) deploy -> verify. Fully detached, file-polled.
set -u
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/t209-final.txt
: > "$OUT"
log(){ echo "$@" >> "$OUT"; }

log '=== [1] safety: local rules.ts must equal box (no-op rsync only) ==='
L=$(md5 -q /Users/mikeolab/spaceworker/lib/hosting/rules.ts)
B=$(ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "md5sum /opt/spaceworker/lib/hosting/rules.ts | cut -d' ' -f1")
log "local=$L box=$B"
if [ "$L" != "$B" ]; then log 'ABORT_RULES_MISMATCH (senior agent: reconcile, then rerun)'; exit 1; fi
printf 'lib/hosting/rules.ts\n' > /tmp/t209-final-list.txt

log '=== [2] launch box tsc (detached on box, unique log) ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "rm -f /root/tsc-final.log; pgrep -f 'tsc --no[E]mit' >/dev/null && echo tsc-already-running || echo none-running
   nohup bash -c 'cd /opt/spaceworker && sudo -u trmm npx --no-install tsc --noEmit > /root/tsc-final.log 2>&1; echo TSC_EXIT=\$? >> /root/tsc-final.log' >/dev/null 2>&1 &
   echo launched"

log '=== [3] poll tsc (max 12 min) ==='
for i in $(seq 1 72); do
  if ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "grep -q TSC_EXIT /root/tsc-final.log 2>/dev/null"; then break; fi
  sleep 10
done
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "tail -1 /root/tsc-final.log" >> "$OUT" 2>&1
if ! ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "grep -q 'TSC_EXIT=0' /root/tsc-final.log 2>/dev/null"; then
  log 'TSC_FAILED -> NO DEPLOY. Senior agent: read /root/tsc-final.log on box.'
  ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "grep -E 'error TS' /root/tsc-final.log | head -25" >> "$OUT" 2>&1
  log CHAIN_DONE
  exit 2
fi
log 'TSC_CLEAN'

log '=== [4] deploy via deploy-vps.sh (prisma gen -> build -> rollback-safe -> health) ==='
cd /Users/mikeolab/spaceworker
bash scripts/deploy-vps.sh /tmp/t209-final-list.txt >> "$OUT" 2>&1
DRC=$?
log "deploy exit=$DRC"

log '=== [5] verify ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "echo -n 'BUILD_ID: '; cat /opt/spaceworker/.next/BUILD_ID 2>/dev/null; echo
   systemctl is-active spaceworker
   curl -s -o /dev/null -w 'localhost:3500 -> %{http_code}\n' -m 15 http://localhost:3500/
   ls /opt/spaceworker/public/maintenance.html >/dev/null 2>&1 && echo MAINTENANCE_PRESENT || echo maintenance-OFF
   echo -n 'license-service md5 on box: '; md5sum /opt/spaceworker/lib/license-service.ts | cut -d' ' -f1
   echo -n 'slice-2 marker (lib/lab live scan): '; ls /opt/spaceworker/lib/lab/ 2>/dev/null | grep -cE 'recon|live|egress' || true
   journalctl -u spaceworker --since '-8min' 2>/dev/null | grep -ciE 'error|failed|module not found' || echo journal-clean" >> "$OUT" 2>&1
curl -s -o /dev/null -w 'public spaceworker.top -> %{http_code}\n' -m 20 https://spaceworker.top/ >> "$OUT" 2>&1
log CHAIN_DONE