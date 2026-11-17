#!/usr/bin/env bash
# Confirm the fix: align box lib/email.ts callers — signature + slice membership
set -u
K="$HOME/.ssh/tacticalrmm_vps"
{
echo '=== [1] sw-lab email.ts:160 full signature (does it require issuedAt?) ==='
sed -n '160,172p' /Users/mikeolab/sw-lab/lib/email.ts

echo '=== [2] origin/main email.ts: same signature (for lineage comparison) ==='
cd /Users/mikeolab/sw-lab && git show origin/main:lib/email.ts 2>/dev/null | sed -n '155,175p' | grep -n -A10 'exeLicenseIssuedEmailHtml(opts' || echo 'no match in window'

echo '=== [3] box exe-licenses route: does IT pass issuedAt? ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "grep -n -A7 'exeLicenseIssuedEmailHtml({' /opt/spaceworker/app/api/admin/exe-licenses/route.ts | head -10 || echo CALLER_MISSING"

echo '=== [4] was exe-licenses route / email.ts in slice-2 list? ==='
grep -nE 'exe-licenses|lib/email' /tmp/egress-files.txt /tmp/cyberlab-files.txt 2>/dev/null || echo 'not in lists'

echo '=== [5] sw-lab vs box: exe-licenses route md5 ==='
md5 -q /Users/mikeolab/sw-lab/app/api/admin/exe-licenses/route.ts 2>/dev/null
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "md5sum /opt/spaceworker/app/api/admin/exe-licenses/route.ts 2>/dev/null || echo MISSING"
echo CONFIRM_DONE
} > /tmp/t209-confirm.txt 2>&1