#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
echo "=== service + site ==="
echo -n "active: "; systemctl is-active spaceworker.service
echo -n ":3500 root: "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 http://localhost:3500/
echo -n "public spaceworker.top: "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 https://spaceworker.top/ 2>/dev/null
echo -n "maintenance: "; ls /var/www/sw-maintenance.on 2>/dev/null && echo ON || echo OFF
echo -n "BUILD_ID (should be NEW, not TPjU5...): "; cat /opt/spaceworker/.next/BUILD_ID
echo "=== cyberlab files present ==="
ls /opt/spaceworker/app/cyberlab/ 2>/dev/null
echo -n "api/cyberlab routes: "; ls /opt/spaceworker/app/api/cyberlab/ 2>/dev/null | tr '\n' ' '; echo
echo -n "console-map.ts: "; ls -la /opt/spaceworker/lib/lab/console-map.ts 2>/dev/null | awk '{print $5}'
echo "=== cyberlab status endpoint (expect NOT 500) ==="
echo -n "/api/cyberlab/status: "; curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 http://localhost:3500/api/cyberlab/status
echo "=== schema sanity: one schema.prisma, client has both cols ==="
find /opt/spaceworker -maxdepth 2 -name schema.prisma -not -path '*/node_modules/*'
echo -n "DB LabTarget.sourceDeviceId: "; sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LabTarget' AND column_name='sourceDeviceId';"
echo -n "DB AdminSetting.deviceMonitorExePriceUsd: "; sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='AdminSetting' AND column_name='deviceMonitorExePriceUsd';"
REMOTE
