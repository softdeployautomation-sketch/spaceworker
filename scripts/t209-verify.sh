#!/usr/bin/env bash
# TASK_209 verify: .vbs allowance live + slice-2 cyberlab baked in + site healthy.
set -u
KEY="$HOME/.ssh/tacticalrmm_vps"
HOST=root@164.68.105.96

echo '=== [1] BUILD_ID + service + maintenance ==='
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" '
echo -n "BUILD_ID: "; cat /opt/spaceworker/.next/BUILD_ID 2>/dev/null; echo
systemctl is-active spaceworker
ls -d /opt/spaceworker/public/maintenance.html >/dev/null 2>&1 && echo "maintenance.html PRESENT" || echo "maintenance OFF"
'

echo '=== [2] old error string absent from built chunks ==='
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" '
grep -r "hosted as downloads" /opt/spaceworker/.next/server/chunks/ 2>/dev/null | wc -l | sed "s/^/error-string hits: /"
grep -rl "gate is retired" /opt/spaceworker/.next/server/chunks/ 2>/dev/null | head -1 | sed "s/^/new-policy marker in chunk: /"
'

echo '=== [3] cyberlab slice-2 markers now baked into the build ==='
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" '
ls /opt/spaceworker/.next/server/app/cyberlab/ 2>/dev/null | head -6 | sed "s/^/built page: /"
'

echo '=== [4] public site ==='
curl -s -o /dev/null -w 'https://spaceworker.top -> %{http_code}\n' --max-time 20 https://spaceworker.top/
echo VERIFY_DONE
