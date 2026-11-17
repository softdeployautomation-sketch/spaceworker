#!/usr/bin/env bash
# probe 2: why is the diag-build ssh hanging — remote npm still alive?
set -u
{
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
echo "--- remote: npm/next build procs ---"
ps -eo pid,ppid,etime,stat,comm,args | grep -E "npm run build|next build|next-build" | grep -v grep | head -8 || echo none
echo "--- BUILD_EXIT line in log? ---"
grep -c "BUILD_EXIT" /root/build-diag-209.log 2>/dev/null || true
echo "--- log mtime ---"
stat -c "%y" /root/build-diag-209.log
echo "--- errant children of ssh session ---"
ps -eo pid,ppid,etime,stat,args | grep -E "sudo -u trmm" | grep -v grep | head -5 || echo none'
echo PROBE2_DONE
} > /tmp/t209-probe2.txt 2>&1