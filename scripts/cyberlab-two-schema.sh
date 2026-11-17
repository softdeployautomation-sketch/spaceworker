#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. ROOT schema.prisma vs prisma/schema.prisma: mtime + size ==="
stat -c '%y  %s  %n' schema.prisma prisma/schema.prisma
echo "=== 2. which one does prisma actually use? (prisma validates default path) ==="
sudo -u trmm npx --no-install prisma validate --schema=schema.prisma 2>&1 | tail -2
echo "--- and prisma/schema.prisma ---"
sudo -u trmm npx --no-install prisma validate --schema=prisma/schema.prisma 2>&1 | tail -2
echo "=== 3. ROOT schema.prisma: does AdminSetting have deviceMonitorExePriceUsd? ==="
awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}' schema.prisma 2>/dev/null | grep -c 'deviceMonitorExePriceUsd'
echo "=== 4. ROOT schema.prisma: does LabTarget have sourceDeviceId? ==="
awk '/model LabTarget /{f=1} f{print} f&&/^}/{exit}' schema.prisma 2>/dev/null | grep -c 'sourceDeviceId'
echo "=== 5. diff ROOT vs prisma/ (are they same file?) ==="
diff -q schema.prisma prisma/schema.prisma && echo "IDENTICAL" || echo "DIFFERENT <<<"
echo "=== 6. how different? line counts ==="
wc -l schema.prisma prisma/schema.prisma
REMOTE
