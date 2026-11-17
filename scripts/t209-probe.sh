#!/usr/bin/env bash
# probe: is the diag build actually running/progressing on the box?
set -u
{
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
echo "--- build/next procs ---"
ps -eo pid,etime,pcpu,comm,args | grep -E "next|npm|tsc" | grep -v grep | head -6
echo "--- build log size + tail ---"
ls -la /root/build-diag-209.log 2>/dev/null
tail -4 /root/build-diag-209.log 2>/dev/null
echo "--- load ---"
cat /proc/loadavg'
echo PROBE_DONE
} > /tmp/t209-probe.txt 2>&1