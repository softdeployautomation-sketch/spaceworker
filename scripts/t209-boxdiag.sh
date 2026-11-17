#!/usr/bin/env bash
# TASK_209 safe diag: fresh .next safety copy + typecheck the box tree (non-destructive).
set -u
OUT=/tmp/t209-boxdiag.txt
{
echo '=== [1] fresh rollback safety copy (rollback consumed .next.prev) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
rm -rf /root/.next.LV5-safety
cp -a /opt/spaceworker/.next /root/.next.LV5-safety && echo "safety copy OK"
ls -lad /root/.next.LV5-safety
'

echo '=== [2] typecheck the BOX tree as trmm (finds missing modules without touching .next) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=60 root@164.68.105.96 '
cd /opt/spaceworker && sudo -u trmm npx --no-install tsc --noEmit > /root/tsc-box.log 2>&1
echo "tsc exit: $?"
wc -l /root/tsc-box.log
head -30 /root/tsc-box.log
'
echo BOXDIAG_DONE
} > "$OUT" 2>&1