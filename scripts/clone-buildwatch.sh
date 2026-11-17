#!/usr/bin/env bash
ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 'pgrep -af "next build" | head -2 || echo NO_BUILD_PROC; echo "--- build log tail ---"; tail -8 /root/last-build.log 2>/dev/null; echo "--- maint ---"; ls /var/www/sw-maintenance.on 2>/dev/null && echo MAINT_ON || echo MAINT_OFF'
