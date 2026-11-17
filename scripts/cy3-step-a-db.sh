#!/usr/bin/env bash
# Step A — migration dir rsync + targeted psql (per HANDOFF_CYBERLAB_DEPLOY_ALL §2).
# NOT db push, NOT migrate deploy: 4 additive DROP+re-ADD CHECK statements.
set -u
trap '' TSTP TTIN TTOU
SSH="ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15"
HOST=root@164.68.105.96
SWL=/Users/mikeolab/sw-lab

echo '=== [A1] pre-DB CHECK state (expect OLD narrow: premium_plus/premium_xdevice + 3,5) ==='
$SSH "$HOST" 'sudo -u postgres psql -d spaceworker -tAc "select conname||chr(10)||pg_get_constraintdef(oid) from pg_constraint where conrelid=(select oid from pg_class where relname='"'"'PremiumInvoice'"'"') and contype='"'"'c'"'"'" | grep -i "plan\|tier"'

echo '=== [A2] rsync migration dir ONLY ==='
cd "$SWL" || exit 1
rsync -azR --itemize-changes -e "ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes" \
  prisma/migrations/20261122000000_task_cyberlab_invoice_addon/ "$HOST:/opt/spaceworker/" || { echo RSYNC_FAIL; exit 1; }
$SSH "$HOST" 'ls /opt/spaceworker/prisma/migrations/20261122000000_task_cyberlab_invoice_addon/ && echo migration_dir_ok'

echo '=== [A3] targeted psql (ON_ERROR_STOP=1) ==='
$SSH "$HOST" 'sudo -u postgres psql -d spaceworker -v ON_ERROR_STOP=1 -f /opt/spaceworker/prisma/migrations/20261122000000_task_cyberlab_invoice_addon/migration.sql; echo PSQL_RC=$?'

echo '=== [A4] post-DB verify (expect cyberlab + 6) ==='
$SSH "$HOST" 'sudo -u postgres psql -d spaceworker -tAc "select conname||chr(10)||pg_get_constraintdef(oid) from pg_constraint where conrelid=(select oid from pg_class where relname='"'"'PremiumInvoice'"'"') and contype='"'"'c'"'"'" | grep -i "plan\|tier"'

echo '=== [A5] re-run safety probe (idempotent-in-effect per handoff) — NO, not needed; skip ==='
echo STEP_A_DONE
