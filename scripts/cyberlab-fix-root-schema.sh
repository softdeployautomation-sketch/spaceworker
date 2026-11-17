#!/usr/bin/env bash
set -u
# Remove the stray ROOT /opt/spaceworker/schema.prisma (orphan, Oct 10, NOT git-tracked)
# that hijacks Prisma's default schema resolution, forcing generate to read a stale
# schema missing deviceMonitorExePriceUsd + sourceDeviceId. Backup first, then remove,
# then prove bare `prisma generate` now picks up the field from prisma/schema.prisma.
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. backup the orphan root schema.prisma ==="
cp -a schema.prisma "/root/spaceworker.ROOT-schema.prisma.bak-$(date +%Y%m%d%H%M%S)" && echo "backed up to /root/spaceworker.ROOT-schema.prisma.bak-*"
echo "=== 2. confirm it is NOT referenced anywhere (package.json / next.config) ==="
grep -rn 'schema.prisma' package.json next.config.* 2>/dev/null || echo "no explicit reference (uses prisma/ default)"
echo "=== 3. remove the orphan ==="
rm -f schema.prisma && echo "removed /opt/spaceworker/schema.prisma"
ls -la schema.prisma 2>&1 | head -1
echo "=== 4. PROOF: bare prisma generate now uses prisma/schema.prisma ==="
sudo -u trmm npx --no-install prisma generate 2>&1 | tail -2
echo -n "deviceMonitorExePriceUsd in client (expect >0 now): "
grep -c deviceMonitorExePriceUsd node_modules/.prisma/client/index.d.ts
echo -n "sourceDeviceId in client (expect >0 now): "
grep -c 'sourceDeviceId' node_modules/.prisma/client/index.d.ts
echo "=== 5. only one schema.prisma remains ==="
find /opt/spaceworker -maxdepth 2 -name 'schema.prisma' -not -path '*/node_modules/*'
REMOTE
