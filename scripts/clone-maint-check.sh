#!/usr/bin/env bash
echo "=== local deploy proc alive? ==="
pgrep -af 'clone-run.sh|deploy-vps.sh' || echo NO_LOCAL_DEPLOY
echo "=== box: build proc + last-build tail + maintenance ==="
ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 'pgrep -af "next build" >/dev/null && echo BUILD_RUNNING || echo BUILD_DONE; echo "--- last 12 of last-build.log ---"; tail -12 /root/last-build.log 2>/dev/null; echo "--- restart marker in log? ---"; grep -c "restart\|maintenance OFF\|-- done" /root/last-build.log 2>/dev/null'
