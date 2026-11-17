#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
echo "=== 1. DB backups in /root (pg_dump / .sql) newest first ==="
ls -lat /root/*.sql /root/*.dump /root/*spaceworker* 2>/dev/null | head -20 || echo "no obvious backups"
echo "=== 2. Any automated pg backup cron/systemd? ==="
ls -la /root/*.bak-* 2>/dev/null | head
echo "=== 3. Current LIVE DB drift vs schema: is it PURELY additive now? (migrate diff) ==="
cd /opt/spaceworker
sudo -u trmm npx --no-install prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script 2>&1 | grep -E 'DROP|ALTER|ADD|CREATE' | head -40
echo "=== 4. Confirm LabTarget.sourceDeviceId still absent (count) ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LabTarget' AND column_name='sourceDeviceId';"
REMOTE
