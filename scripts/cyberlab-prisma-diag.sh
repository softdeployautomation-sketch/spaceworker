#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. prisma generator block in schema (output path?) ==="
awk '/generator /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma
echo "=== 2. ALL generator blocks ==="
grep -n 'generator ' prisma/schema.prisma
echo "=== 3. where does @prisma/client actually resolve? ==="
sudo -u trmm node -e "console.log(require.resolve('@prisma/client'))" 2>&1 | head
echo "=== 4. is .prisma/client a real dir or symlink? ==="
ls -la node_modules/.prisma/client/ 2>/dev/null | head -5
echo "=== 5. does the DEFAULT client dir have the field? (maybe output is custom) ==="
find node_modules/.prisma -name 'index.d.ts' 2>/dev/null | head
for f in $(find node_modules/.prisma -name '*.d.ts' 2>/dev/null); do
  c=$(grep -c 'deviceMonitorExePriceUsd' "$f" 2>/dev/null)
  [ "$c" != "0" ] && echo "FOUND in $f ($c)"
done
echo "=== 6. grep the WHOLE generated client tree for the field ==="
grep -rl 'deviceMonitorExePriceUsd' node_modules/.prisma/ node_modules/@prisma/client/ 2>/dev/null | head
echo "=== 7. sanity: does generate see the RIGHT schema? print datasource+model count ==="
sudo -u trmm npx --no-install prisma validate 2>&1 | tail -4
REMOTE
