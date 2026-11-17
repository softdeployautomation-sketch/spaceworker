#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
echo "=== A. Reference: deviceMonitorExePriceUsd value in the Oct-9 dump ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "zcat /root/spaceworker-t187-20261009020437.sql.gz 2>/dev/null | grep -iE 'deviceMonitorExePriceUsd|COPY .*AdminSetting' | head -20" 2>&1 | head -30
echo
echo "=== B. Does app code READ deviceMonitorExePriceUsd anywhere? (impact) ==="
cd /Users/mikeolab/spaceworker || exit 1
grep -rn 'deviceMonitorExePriceUsd' --include='*.ts' --include='*.tsx' app lib components 2>/dev/null | head -20 || echo "no code references"
echo
echo "=== C. When was deviceMonitorExePriceUsd added to schema? (git log) ==="
git log --oneline -S 'deviceMonitorExePriceUsd' -- prisma/schema.prisma | head -5
