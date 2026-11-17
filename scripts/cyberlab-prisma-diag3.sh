#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. EXACT line + context of deviceMonitorExePriceUsd in box schema ==="
grep -n 'deviceMonitorExePriceUsd' prisma/schema.prisma
echo "--- 3 lines around it ---"
grep -n -B2 -A1 'deviceMonitorExePriceUsd' prisma/schema.prisma
echo "=== 2. which MODEL is that line inside? (show the model header above it) ==="
awk 'NR<=FNR{next}1' /dev/null prisma/schema.prisma >/dev/null 2>&1
line=$(grep -n 'deviceMonitorExePriceUsd' prisma/schema.prisma | head -1 | cut -d: -f1)
echo "field at line $line"
awk -v L="$line" 'NR<=L && /^model /{m=$0; ml=NR} END{print "inside model: " m " (starts line " ml ")"}' prisma/schema.prisma
echo "=== 3. any OTHER .prisma files on the box? ==="
find /opt/spaceworker -name '*.prisma' -not -path '*/node_modules/*' 2>/dev/null
echo "=== 4. compare box schema AdminSetting model vs sw-lab's (should be identical) ==="
awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma | grep -c 'deviceMonitorExePriceUsd'
echo "=== 5. does sw-lab schema REALLY have it in AdminSetting? (local truth) ==="
awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}' /Users/mikeolab/sw-lab/prisma/schema.prisma 2>/dev/null | grep -c 'deviceMonitorExePriceUsd' || echo "(sw-lab not mounted here)"
REMOTE
