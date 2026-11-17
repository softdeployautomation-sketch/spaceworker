#!/usr/bin/env bash
set -u
# Clean, self-contained clone deploy runner. Foreground, trap-immune, full log.
cd /Users/mikeolab/spaceworker || exit 1
trap '' TSTP TTIN TTOU
echo "=== pre-flight: site healthy before we touch it ==="
curl -s -o /dev/null -w 'public spaceworker.top: %{http_code}\n' --max-time 15 https://spaceworker.top/ 2>/dev/null
echo "=== current BUILD_ID (before) ==="
ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes root@164.68.105.96 'cat /opt/spaceworker/.next/BUILD_ID 2>/dev/null; echo'
echo "=== running deploy (16 files: 15 clone libs + merged device-console.tsx) ==="
bash scripts/deploy-vps.sh /tmp/clone-files.txt
echo "=== DEPLOY_RC=$? ==="
