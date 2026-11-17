#!/usr/bin/env bash
set -u
SSH="ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96"
$SSH 'cat "/opt/vantra/lib/meshcentral-api.ts"' > /tmp/box-mca.ts 2>/dev/null
$SSH 'cat "/opt/vantra/app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts"' > /tmp/box-mint.ts 2>/dev/null
echo "=== meshcentral-api: BOX-ONLY lines (would be lost by rsync) ==="
diff /tmp/box-mca.ts /Users/mikeolab/vantra/lib/meshcentral-api.ts > /tmp/mca-diff.txt
echo "diff exit=$? (0=identical)"
grep '^<' /tmp/mca-diff.txt | head -30
echo "=== count of box-only lines ==="
grep -c '^<' /tmp/mca-diff.txt
echo "=== mint route: BOX-ONLY lines ==="
diff /tmp/box-mint.ts "/Users/mikeolab/vantra/app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts" > /tmp/mint-diff.txt
grep '^<' /tmp/mint-diff.txt | head -30
echo "=== local branch state (must be clean on task-207-mesh-scoped-mint) ==="
git -C /Users/mikeolab/vantra branch --show-current
git -C /Users/mikeolab/vantra status --short | head -8
echo "=== CHECK DONE ==="
