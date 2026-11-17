#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== BOX schema.prisma: sourceDeviceId occurrences ==="
grep -n 'sourceDeviceId' prisma/schema.prisma | head
echo "=== BOX schema.prisma: deviceMonitorExePriceUsd occurrences ==="
grep -n 'deviceMonitorExePriceUsd' prisma/schema.prisma | head
echo "=== BOX schema.prisma: mtime + first line (did scp land?) ==="
stat -c '%y %s bytes' prisma/schema.prisma
echo "=== LIVE DB: AdminSetting columns (deviceMonitorExePriceUsd still there?) ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='AdminSetting' ORDER BY ordinal_position;" | tr '\n' ' '; echo
echo "=== LIVE DB: LabTarget has sourceDeviceId? ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LabTarget' AND column_name='sourceDeviceId';"
REMOTE
