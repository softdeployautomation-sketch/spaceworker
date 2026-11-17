#!/usr/bin/env bash
set -u
cd /Users/mikeolab/sw-lab || exit 1
echo '=== stub-server-only.cjs exists in sw-lab? ==='
ls -la scripts/stub-server-only.cjs 2>&1
echo '=== does it exist on the LIVE box? ==='
ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes root@164.68.105.96 'ls -la /opt/spaceworker/scripts/stub-server-only.cjs 2>&1'
echo '=== imports referenced by the 3 new app dirs + lib/lab that are NOT in my deploy list ==='
echo '--- checking each new/changed source file for @/lib and relative imports ---'
grep -rhoE "from \"(@/[^\"]+|\.\.?/[^\"]+)\"" \
  app/cyberlab app/api/cyberlab app/api/admin/cyberlab \
  lib/lab/engine.ts lib/lab/runner.ts lib/lab/range.ts lib/lab/scenarios.ts \
  lib/lab/episode.ts lib/lab/evidence.ts lib/lab/targets.ts lib/lab/targets-core.ts \
  lib/lab/victim-sensor.ts lib/lab/catalog-seed.ts lib/lab/console-map.ts \
  lib/resource-governor.ts \
  components/cyberlab-ops-console.tsx components/cyberlab-panel.tsx components/admin-lab-runs-view.tsx \
  2>/dev/null | sed -E 's/from "//; s/"//' | sort -u > /tmp/cy_imports.txt
echo '--- unique import specifiers ---'
cat /tmp/cy_imports.txt
echo '=== which @/lib imports are clone/other-risky? (must all resolve on live) ==='
grep -E 'clone|hosting|vantra' /tmp/cy_imports.txt || echo 'none clone/hosting/vantra imports (good)'
