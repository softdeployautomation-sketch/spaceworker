#!/usr/bin/env bash
# TASK_209 direct restore: license-service (proven clobber) + products classification,
# then relaunch the box typecheck against the fixed tree.
set -u
cd /Users/mikeolab/spaceworker
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/t209-restore2.txt
{
echo '=== [1] products.ts classification ==='
git show "origin/mailer-exe:lib/products.ts" > /tmp/_p_mailer.ts 2>/dev/null && echo "mailer md5: $(md5 -q /tmp/_p_mailer.ts)" || echo 'not in mailer-exe'
echo "sw-lab md5: $(md5 -q /Users/mikeolab/sw-lab/lib/products.ts)"
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96 "echo -n 'box md5: '; md5sum /opt/spaceworker/lib/products.ts | cut -d' ' -f1"
echo "--- does mailer products.ts have the cyberlab-needed export? ---"
grep -c 'LICENSABLE_EXE_PRODUCTS' /tmp/_p_mailer.ts 2>/dev/null || echo 0

echo '=== [2] RESTORE lib/license-service.ts from mailer-exe (the proven fix) ==='
git show "origin/mailer-exe:lib/license-service.ts" > /tmp/_license_mailer.ts
echo "local md5: $(md5 -q /tmp/_license_mailer.ts) (expect 4365a413...)"
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96 \
  "cp /opt/spaceworker/lib/license-service.ts /root/clobber-backup-t209/lib_license-service.swlab.ts; echo backup-ok"
scp -i "$K" -o BatchMode=yes -o ConnectTimeout=10 /tmp/_license_mailer.ts root@164.68.105.96:/opt/spaceworker/lib/license-service.ts
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96 \
  "chown trmm:trmm /opt/spaceworker/lib/license-service.ts
   echo -n 'box now: '; md5sum /opt/spaceworker/lib/license-service.ts | cut -d' ' -f1"

echo '=== [3] kill the stale tsc (running against old tree), relaunch fresh ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "pkill -f 'tsc --no[E]mit' 2>/dev/null; sleep 1
   rm -f /root/tsc-after-fix.log
   nohup bash -c 'cd /opt/spaceworker && sudo -u trmm npx --no-install tsc --noEmit > /root/tsc-after-fix.log 2>&1; echo TSC_EXIT=\$? >> /root/tsc-after-fix.log' >/dev/null 2>&1 &
   echo relaunched"
echo RESTORE2_DONE
} > "$OUT" 2>&1