#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
echo "=== PROOF: which schema does bare 'prisma generate' use? ==="
echo "root schema.prisma is NOT git-tracked (orphan, Oct 10)."
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'cd /opt/spaceworker && sudo -u trmm npx --no-install prisma generate 2>&1 | tail -2 && echo -n "deviceMonitorExePriceUsd in generated client (root schema used => expect 0): " && grep -c deviceMonitorExePriceUsd node_modules/.prisma/client/index.d.ts'
echo
echo "=== Now generate EXPLICITLY against prisma/schema.prisma ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'cd /opt/spaceworker && sudo -u trmm npx --no-install prisma generate --schema=prisma/schema.prisma 2>&1 | tail -2 && echo -n "deviceMonitorExePriceUsd in generated client (prisma/ schema => expect >0): " && grep -c deviceMonitorExePriceUsd node_modules/.prisma/client/index.d.ts'
