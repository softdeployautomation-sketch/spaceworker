#!/usr/bin/env bash
set -u
# Controlled recovery: the deploy orchestrator died after a successful build but before
# restart + maintenance-off. Build is verified clean. Now: restart to load new .next,
# clear maintenance, verify.
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96

echo "=== restart spaceworker to load new build ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "systemctl restart spaceworker.service && sleep 4 && echo -n 'active: ' && systemctl is-active spaceworker.service"
echo "=== clear maintenance flag ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "rm -f /var/www/sw-maintenance.on && echo -n 'maint: ' && (ls /var/www/sw-maintenance.on 2>/dev/null && echo STILL_ON || echo OFF)"
echo "=== verify ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cd /opt/spaceworker; echo -n ':3500: '; curl -s -o /dev/null -w %{http_code} --max-time 10 http://localhost:3500/; echo; echo -n 'public: '; curl -s -o /dev/null -w %{http_code} --max-time 15 https://spaceworker.top/ 2>/dev/null; echo; echo -n 'BUILD_ID: '; cat .next/BUILD_ID; echo; echo -n 'service start: '; systemctl show spaceworker.service -p ActiveEnterTimestamp --value"
echo "=== local: also assert runtime survived ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cd /opt/spaceworker && for x in .env .next node_modules static/maintenance.html; do [ -e \$x ] && echo \"ok \$x\" || echo \"MISSING \$x\"; done"
