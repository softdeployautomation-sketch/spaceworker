#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. schema.prisma has deviceMonitorExePriceUsd? ==="
grep -c 'deviceMonitorExePriceUsd' prisma/schema.prisma
echo "=== 2. does the GENERATED client have it? (grep the generated types) ==="
grep -rl 'deviceMonitorExePriceUsd' node_modules/.prisma/client/ 2>/dev/null | head
grep -rc 'deviceMonitorExePriceUsd' node_modules/.prisma/client/index.d.ts 2>/dev/null || echo "0 in index.d.ts"
echo "=== 3. AdminSettingPriceFields type in lib (source) — does it list the field? ==="
grep -rn 'deviceMonitorExePriceUsd\|AdminSettingPriceFields' lib/ | head
echo "=== 4. re-run prisma generate explicitly and watch for the field ==="
sudo -u trmm npx --no-install prisma generate 2>&1 | tail -6
echo "=== 5. after generate, is it in the client now? ==="
grep -rc 'deviceMonitorExePriceUsd' node_modules/.prisma/client/index.d.ts 2>/dev/null || echo "still 0"
REMOTE
