#!/usr/bin/env bash
# TASK_207 S3 step 1: deploy the scoped mint (Vantra) FIRST, then spaceworker.
# Rules: TSTP-immune, full build log, BUILD_ID rollback guard, no maintenance
# page (Vantra has none; spaceworker's flag is NOT touched).
set -u
trap '' TSTP TTIN TTOU
SSH="ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15"
HOST=root@164.68.105.96
LOG=/tmp/t207-vantra-deploy.log
SRC=/Users/mikeolab/vantra
exec > >(tee -a "$LOG") 2>&1
rm -f "$LOG"

echo "=== [1] PRE-STATE ==="
OLD_BID=$($SSH "$HOST" 'cat /opt/vantra/.next/BUILD_ID 2>/dev/null')
echo "old BUILD_ID: $OLD_BID"
$SSH "$HOST" "systemctl is-active \$(systemctl list-units --type=service --no-legend | awk '{print \$1}' | grep -i '^vantra' | head -1) 2>/dev/null || echo service-name-not-found"
$SSH "$HOST" 'curl -s -o /dev/null -w "pre :3300 = %{http_code}\n" --max-time 8 http://127.0.0.1:3300/' || true

echo "=== [2] RSYNC (only the 2 files; bracket dir quoted) ==="
cd "$SRC" || exit 1
rsync -azR --itemize-changes -e "ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes" \
  lib/meshcentral-api.ts \
  "app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts" \
  "$HOST:/opt/vantra/" || { echo RSYNC_FAIL; exit 1; }
$SSH "$HOST" 'chown -R vantra:vantra /opt/vantra/lib/meshcentral-api.ts "/opt/vantra/app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts" && echo chown_ok'
$SSH "$HOST" 'grep -c "scope" "/opt/vantra/app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts" | sed "s/^/box route scope refs after rsync: /"'

echo "=== [3] BACKUP .next ==="
$SSH "$HOST" 'rm -rf /opt/vantra/.next.bak-t207 && cp -a /opt/vantra/.next /opt/vantra/.next.bak-t207 && echo backup_ok'

echo "=== [4] BUILD (as vantra, full log) ==="
$SSH "$HOST" 'cd /opt/vantra && sudo -u vantra npm run build > /tmp/vantra-build-t207.log 2>&1; echo BUILD_RC=$?'
NEW_BID=$($SSH "$HOST" 'cat /opt/vantra/.next/BUILD_ID 2>/dev/null')
echo "new BUILD_ID: ${NEW_BID:-<missing>}"
$SSH "$HOST" 'tail -4 /tmp/vantra-build-t207.log'

if [ "$NEW_BID" = "$OLD_BID" ] || [ -z "$NEW_BID" ]; then
  echo "=== [5] BUILD FAILED -> ROLLBACK ==="
  $SSH "$HOST" 'rm -rf /opt/vantra/.next && mv /opt/vantra/.next.bak-t207 /opt/vantra/.next && chown -R vantra:vantra /opt/vantra/.next && systemctl restart vantra && sleep 3 && cat /opt/vantra/.next/BUILD_ID && curl -s -o /dev/null -w "post-rollback :3300 = %{http_code}\n" --max-time 8 http://127.0.0.1:3300/'
  echo "ROLLED_BACK_EXIT_1"
  exit 1
fi

echo "=== [5] RESTART + VERIFY ==="
$SSH "$HOST" 'systemctl restart vantra && sleep 4 && systemctl is-active vantra && curl -s -o /dev/null -w "post :3300 = %{http_code}\n" --max-time 8 http://127.0.0.1:3300/ && grep -c "scope" "/opt/vantra/app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts" | sed "s/^/box route scope refs: /"'
rm -rf /opt/vantra/.next.bak-t207 2>/dev/null
$SSH "$HOST" 'rm -rf /opt/vantra/.next.bak-t207'
echo "VANTRA_DEPLOY_OK old=$OLD_BID new=$NEW_BID"
