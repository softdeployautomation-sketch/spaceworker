#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. Is deviceMonitorExePriceUsd in LIVE DB AdminSetting RIGHT NOW? ==="
sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='AdminSetting' AND column_name='deviceMonitorExePriceUsd';"
echo "=== 2. Box schema.prisma: does AdminSetting model contain it? (what prisma actually reads) ==="
awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma | grep -c 'deviceMonitorExePriceUsd'
echo "=== 3. Any OTHER schema.prisma on the box that prisma might use? (prisma.schema / config) ==="
grep -rn 'schema' package.json 2>/dev/null | grep -i prisma || echo "no prisma.schema override in package.json"
ls -la prisma/*.prisma 2>/dev/null
echo "=== 4. FULL drift: prisma migrate diff (DB -> schema). What would change? ==="
sudo -u trmm npx --no-install prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script 2>&1 | head -60
REMOTE
