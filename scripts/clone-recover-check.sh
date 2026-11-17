#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
echo "=== 1. build errors in last-build.log? ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "grep -iE 'error|failed|cannot find|module not found|Type error' /root/last-build.log 2>/dev/null | head -20 || true; echo '--- exit/rollback markers ---'; grep -cE 'build FAILED|rolling back|restart|-- done' /root/last-build.log 2>/dev/null"
echo "=== 2. .next integrity + BUILD_ID ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cd /opt/spaceworker && echo -n 'BUILD_ID: '; cat .next/BUILD_ID; echo; echo -n 'BUILD_ID file mtime: '; stat -c '%y' .next/BUILD_ID; echo -n '.next.prev exists (rollback copy): '; ls -d .next.prev 2>/dev/null && echo YES || echo NO; echo -n 'required build artifacts: '; for d in .next/server .next/static; do [ -d \$d ] && echo -n \"\$d OK \" || echo -n \"\$d MISSING \"; done; echo"
echo "=== 3. is the RUNNING service on the new build? (check served build via a header/log is unreliable; compare .next mtime to service start) ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "systemctl show spaceworker.service -p ActiveEnterTimestamp"
