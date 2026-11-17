#!/usr/bin/env bash
# Preflight for the cyberlab COMBINED money-flow deploy (HANDOFF_CYBERLAB_DEPLOY_ALL.md).
# 1) box state  2) admin-panel.tsx collision analysis  3) sw-lab tree + file list existence
set -u
SSH="ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15"
HOST=root@164.68.105.96
SWL=/Users/mikeolab/sw-lab

echo '=== [1] BOX STATE ==='
$SSH "$HOST" 'echo "BUILD_ID: $(cat /opt/spaceworker/.next/BUILD_ID)"; systemctl is-active spaceworker; echo "maintenance: $(ls /var/www/sw-maintenance.on 2>/dev/null || echo OFF)"; echo "--- PremiumInvoice CHECKs (must be OLD narrow now) ---"; sudo -u postgres psql -d spaceworker -tAc "select conname||chr(10)||pg_get_constraintdef(oid) from pg_constraint where conrelid=(select oid from pg_class where relname='"'"'PremiumInvoice'"'"') and contype='"'"'c'"'"'"; echo "--- box module-tool-lock copy (expect OLD: 0 Add-Cyber-Lab) ---"; grep -c "Add Cyber Lab" /opt/spaceworker/components/module-tool-lock.tsx'

echo
echo '=== [2] ADMIN-PANEL COLLISION ANALYSIS ==='
$SSH "$HOST" 'cat "/opt/spaceworker/app/admin=topsecret6199/(protected)/admin-panel.tsx"' > /tmp/cy3-box-adminpanel.tsx 2>/dev/null
echo "box admin-panel: $(wc -l < /tmp/cy3-box-adminpanel.tsx) lines, md5 $(md5 -q /tmp/cy3-box-adminpanel.tsx)"
echo "sw-lab admin-panel: $(wc -l < "$SWL/app/admin=topsecret6199/(protected)/admin-panel.tsx") lines, md5 $(md5 -q "$SWL/app/admin=topsecret6199/(protected)/admin-panel.tsx")"
echo '--- diff stats box vs sw-lab (changed line count) ---'
diff /tmp/cy3-box-adminpanel.tsx "$SWL/app/admin=topsecret6199/(protected)/admin-panel.tsx" | grep -c '^[<>]'
echo '--- task205 markers IN BOX admin-panel (wording/mobileTarget/split) ---'
grep -n -i 'wording\|mobileTarget\|Split by device\|desktopOnly' /tmp/cy3-box-adminpanel.tsx | head -10 || echo '(none)'
echo '--- cyberlab markers IN sw-lab admin-panel (cyberlab tab) ---'
grep -n -i "cyberlab" "$SWL/app/admin=topsecret6199/(protected)/admin-panel.tsx" | head -10 || echo '(none)'
echo '--- task205 markers IN spaceworker LOCAL committed admin-panel ---'
grep -n -i 'wording\|mobileTarget\|Split by device' "/Users/mikeolab/spaceworker/app/admin=topsecret6199/(protected)/admin-panel.tsx" | head -10 || echo '(none)'

echo
echo '=== [3] SW-LAB TREE + FILE LIST ==='
cd "$SWL" || exit 1
echo "branch: $(git branch --show-current), HEAD: $(git rev-parse --short HEAD)"
echo "ahead of origin/main: $(git rev-list --count origin/main..HEAD 2>/dev/null || echo unknown)"
echo "tree: $(git status --porcelain | wc -l | tr -d ' ') dirty entries"
echo '--- last 4 commits ---'
git --no-pager log --oneline -4
echo '--- the 16 ship entries exist? ---'
while IFS= read -r f; do
  [ -e "$f" ] && echo "ok   $f" || echo "MISS $f"
done <<'LIST'
lib/products.ts
lib/license-service.ts
lib/invoice-notify.ts
lib/support-templates.ts
app/api/admin/users/[id]/invoices/route.ts
app/api/admin/users/[id]/invoices/[invoiceId]/route.ts
app/api/admin/wallets/route.ts
app/api/billing/submit/route.ts
app/dashboard/billing/page.tsx
components/support-invoice-card.tsx
components/module-tool-lock.tsx
components/admin/support-queue-panel.tsx
components/admin/user-invoice-cell.tsx
components/admin/cyberlab-access-cell.tsx
app/admin=topsecret6199/(protected)/admin-panel.tsx
prisma/migrations/20261122000000_task_cyberlab_invoice_addon/
LIST
echo '--- migration.sql content (must equal the handoff 4 statements) ---'
cat prisma/migrations/20261122000000_task_cyberlab_invoice_addon/migration.sql 2>/dev/null
echo '=== PREFLIGHT DONE ==='
