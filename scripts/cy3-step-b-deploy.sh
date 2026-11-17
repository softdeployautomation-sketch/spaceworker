#!/usr/bin/env bash
# Step B — full cyberlab money-flow deploy: hardened deploy-vps.sh with
# LOCAL_ROOT=/Users/mikeolab/sw-lab (the code is local-only per handoff §0.4).
set -u
trap '' TSTP TTIN TTOU
cat > /tmp/cy3-files.txt <<'LIST'
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
echo "list: $(wc -l < /tmp/cy3-files.txt) entries"
cd /Users/mikeolab/spaceworker || exit 1
LOCAL_ROOT=/Users/mikeolab/sw-lab bash scripts/deploy-vps.sh /tmp/cy3-files.txt
echo "DEPLOY_RC=$?"
