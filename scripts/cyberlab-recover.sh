#!/usr/bin/env bash
set -u
# SAFE recovery: the live DB drifted behind origin/main (missing deviceMonitorExePriceUsd,
# 11 CloneJob clone-state cols, LabTarget.sourceDeviceId). My earlier --accept-data-loss
# push wrongly DROPPED deviceMonitorExePriceUsd. The CURRENT diff is purely ADDITIVE, so we
# reconcile with explicit, audited SQL (no --accept-data-loss, no prisma guessing).
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. Regenerate the EXACT additive SQL and prove it has ZERO drops ==="
sudo -u trmm npx --no-install prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script > /tmp/cy_reconcile.sql 2>/tmp/cy_reconcile.err
echo "--- DROP statements present? (must be 0) ---"
DROPS=$(grep -ci 'DROP' /tmp/cy_reconcile.sql)
echo "$DROPS"
if [ "$DROPS" != "0" ]; then
  echo "ABORT: reconcile SQL contains DROP statements. Refusing to apply. Manual review required."
  cat /tmp/cy_reconcile.sql
  exit 1
fi
echo "--- the SQL to apply (additive only) ---"
cat /tmp/cy_reconcile.sql
echo "=== 2. Apply via psql (as postgres superuser) ==="
sudo -u postgres psql -d spaceworker -v ON_ERROR_STOP=1 -f /tmp/cy_reconcile.sql 2>&1 | tail -20
echo "=== 3. VERIFY all three restored ==="
echo -n "deviceMonitorExePriceUsd: "; sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='AdminSetting' AND column_name='deviceMonitorExePriceUsd';"
echo -n "LabTarget.sourceDeviceId: "; sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='LabTarget' AND column_name='sourceDeviceId';"
echo -n "CloneJob.stateManifest:  "; sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name='CloneJob' AND column_name='stateManifest';"
echo "=== 4. Re-run migrate diff: expect EMPTY (DB now == schema) ==="
sudo -u trmm npx --no-install prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script 2>&1 | grep -E 'ALTER|ADD|DROP|CREATE' | head || echo "(no schema changes remain)"
REMOTE
