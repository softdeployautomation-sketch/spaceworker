#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
echo "=== 1. is root schema.prisma in the LOCAL git repo? (should be NO) ==="
cd /Users/mikeolab/spaceworker || exit 1
git ls-files | grep -E '^schema.prisma$' && echo "TRACKED (do NOT delete)" || echo "NOT tracked in repo"
cd /Users/mikeolab/sw-lab || exit 1
git ls-files | grep -E '^schema.prisma$' && echo "TRACKED in sw-lab" || echo "NOT tracked in sw-lab"
echo "=== 2. does the root schema.prisma differ from prisma/ in a way that matters? datasource same? ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'cd /opt/spaceworker; echo \"--- root datasource ---\"; awk \"/datasource /\",/^}/\" schema.prisma; echo \"--- prisma/ datasource ---\"; awk \"/datasource /\",/^}/\" prisma/schema.prisma'
echo "=== 3. PROOF prisma uses root: generate then check a field ONLY in prisma/schema.prisma ==='
ssh -i \"$KEY\" -o BatchMode=yes \"$HOST\" 'cd /opt/spaceworker; sudo -u trmm npx --no-install prisma generate 2>&1 | tail -2; echo -n \"deviceMonitorExePriceUsd in client after generate: \"; grep -c deviceMonitorExePriceUsd node_modules/.prisma/client/index.d.ts'
