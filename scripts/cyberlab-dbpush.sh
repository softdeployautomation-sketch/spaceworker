#!/usr/bin/env bash
set -u
# Pre-step: put sw-lab's schema.prisma on the box, then db push (adds the
# nullable LabTarget.sourceDeviceId). Additive + nullable = no downtime needed,
# and the app is NOT restarted here, so there is no 500 window. The full
# deploy-vps.sh run afterwards re-syncs everything and does generate+build+restart.
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
SW=/Users/mikeolab/sw-lab

echo "=== 1. scp sw-lab schema.prisma -> box (targeted, no restart) ==="
scp -i "$KEY" -o BatchMode=yes "$SW/prisma/schema.prisma" "$HOST:/opt/spaceworker/prisma/schema.prisma"
ssh -i "$KEY" -o BatchMode=yes "$HOST" "chown trmm:trmm /opt/spaceworker/prisma/schema.prisma && echo chown_ok"
echo "=== 2. confirm the box schema now has sourceDeviceId ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "grep -c sourceDeviceId /opt/spaceworker/prisma/schema.prisma"

ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== BEFORE: LabTarget columns ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='LabTarget' ORDER BY ordinal_position;" | tr '\n' ' '; echo
echo "=== prisma db push (additive: LabTarget.sourceDeviceId) ==="
sudo -u trmm npx --no-install prisma db push --accept-data-loss 2>&1 | tail -20
echo "=== AFTER: LabTarget columns ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT column_name FROM information_schema.columns WHERE table_name='LabTarget' ORDER BY ordinal_position;" | tr '\n' ' '; echo
echo "=== sourceDeviceId present? (expect 1) ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LabTarget' AND column_name='sourceDeviceId';"
REMOTE
