#!/usr/bin/env bash
# Why does the box build fail: caller/callee mismatch on exeLicenseIssuedEmailHtml
set -u
K="$HOME/.ssh/tacticalrmm_vps"
{
echo '=== [1] which file DEFINES exeLicenseIssuedEmailHtml (sw-lab) ==='
grep -rln 'export.*exeLicenseIssuedEmailHtml' /Users/mikeolab/sw-lab/lib /Users/mikeolab/sw-lab/app 2>/dev/null

echo '=== [2] every CALLER in sw-lab: does it pass issuedAt? ==='
grep -rn 'exeLicenseIssuedEmailHtml(' /Users/mikeolab/sw-lab/lib /Users/mikeolab/sw-lab/app 2>/dev/null | head -6

echo '=== [3] license-service.ts: sw-lab caller has issuedAt? ==='
grep -n -A8 'exeLicenseIssuedEmailHtml({' /Users/mikeolab/sw-lab/lib/license-service.ts | head -14

echo '=== [4] BOX license-service.ts: same call (expect missing issuedAt) ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "grep -n -A8 'exeLicenseIssuedEmailHtml({' /opt/spaceworker/lib/license-service.ts | head -14"

echo '=== [5] was license-service.ts in the slice-2 deploy list? ==='
grep -c 'license-service' /tmp/egress-files.txt 2>/dev/null || echo '0 or list gone'
grep -c 'license-service' /tmp/cyberlab-files.txt 2>/dev/null || echo '0 or list gone'

echo '=== [6] is the DEFINING file on box == sw-lab? (md5) ==='
DEF=$(grep -rln 'export.*exeLicenseIssuedEmailHtml' /Users/mikeolab/sw-lab/lib 2>/dev/null | head -1)
echo "def file: $DEF"
md5 -q "$DEF" 2>/dev/null
REL="${DEF#/Users/mikeolab/sw-lab/}"
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "md5sum '/opt/spaceworker/$REL' 2>/dev/null || echo MISSING_ON_BOX"

echo '=== [7] sw-lab license-service vs box (md5 + import closure of that file) ==='
md5 -q /Users/mikeolab/sw-lab/lib/license-service.ts
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 "md5sum /opt/spaceworker/lib/license-service.ts 2>/dev/null"
grep -oE "from ['\"]@/[^'\"]+|from ['\"]\./[^'\"]+" /Users/mikeolab/sw-lab/lib/license-service.ts | sort -u | head -20
echo DIAG_DONE
} > /tmp/t209-mismatch.txt 2>&1