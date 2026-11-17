#!/usr/bin/env bash
# TASK_209 deploy: ship lib/hosting/rules.ts, full server build (rollback-safe), restart.
set -u
cd /Users/mikeolab/spaceworker
printf 'lib/hosting/rules.ts\n' > /tmp/t209-files.txt
echo "=== list ==="; cat /tmp/t209-files.txt
rm -f /tmp/t209-deploy.log
bash scripts/deploy-vps.sh /tmp/t209-files.txt
echo "DEPLOY_RC=$?"
