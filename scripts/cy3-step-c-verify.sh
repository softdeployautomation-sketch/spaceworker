#!/usr/bin/env bash
# Step C — post-deploy verification (HANDOFF_CYBERLAB_DEPLOY_ALL §4, remote parts).
set -u
SSH="ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15"
HOST=root@164.68.105.96

echo '=== [C1] build + service ==='
$SSH "$HOST" 'echo "BUILD_ID: $(cat /opt/spaceworker/.next/BUILD_ID)"; systemctl is-active spaceworker; echo "maintenance: $(ls /var/www/sw-maintenance.on 2>/dev/null || echo OFF)"; curl -s -o /dev/null -w ":3500=%{http_code}\n" --max-time 8 http://127.0.0.1:3500/'

echo '=== [C2] CHECK constraints (expect cyberlab + 6) ==='
$SSH "$HOST" 'sudo -u postgres psql -d spaceworker -tAc "select conname||chr(10)||pg_get_constraintdef(oid) from pg_constraint where conrelid=(select oid from pg_class where relname='"'"'PremiumInvoice'"'"') and contype='"'"'c'"'"'" | grep -i "plan\|tier"'

echo '=== [C3] NEW COPY inside BUILT chunks ==='
$SSH "$HOST" 'cd /opt/spaceworker/.next; for s in "Add Cyber Lab to your subscription" "Request for Cyber Lab" "Cyber Lab" ; do c=$(grep -rl "$s" static/chunks/ 2>/dev/null | wc -l); echo "chunk files containing [$s]: $c"; done'

echo '=== [C4] box file hashes == sw-lab source (exact deploy) ==='
for f in "app/admin=topsecret6199/(protected)/admin-panel.tsx" components/module-tool-lock.tsx lib/products.ts lib/license-service.ts components/admin/cyberlab-access-cell.tsx; do
  l=$(md5 -q "/Users/mikeolab/sw-lab/$f")
  r=$($SSH "$HOST" "md5sum '/opt/spaceworker/$f' 2>/dev/null" | cut -d' ' -f1)
  [ "$l" = "$r" ] && echo "match  $f" || echo "DIFFER $f (local=$l box=$r)"
done

echo '=== [C5] module-tool-lock NOW has the add-on CTA (grep box source) ==='
$SSH "$HOST" 'grep -c "Add Cyber Lab" /opt/spaceworker/components/module-tool-lock.tsx; grep -c "Request for Cyber Lab" /opt/spaceworker/components/module-tool-lock.tsx'

echo '=== [C6] admin-panel has the cyberlab tab + no stale Infrastructure block ==='
$SSH "$HOST" 'grep -c "cyberlab" "/opt/spaceworker/app/admin=topsecret6199/(protected)/admin-panel.tsx"; grep -c "CyberLabAccessCell" "/opt/spaceworker/app/admin=topsecret6199/(protected)/admin-panel.tsx"'

echo '=== [C7] public ==='
curl -s -o /dev/null -w 'spaceworker.top=%{http_code}\n' --max-time 12 https://spaceworker.top/

echo '=== [C8] journal errors since restart ==='
$SSH "$HOST" 'journalctl -u spaceworker --since "8 min ago" --no-pager 2>/dev/null | grep -ci "error\|unhandled" || true'
echo STEP_C_DONE
