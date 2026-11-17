#!/usr/bin/env bash
set -e
cd /Users/mikeolab/spaceworker
git add \
  app/api/hosting/links/route.ts \
  'app/api/hosting/links/[id]/route.ts' \
  app/r/[token]/route.ts \
  components/hosting-panel.tsx \
  lib/hosting/links-engine.ts \
  lib/hosting/links.ts \
  lib/hosting/workers.ts \
  prisma/schema.prisma \
  tests/hosting-desktop-gate.test.ts \
  prisma/migrations/20261122000000_task205_link_routing_and_wording/
echo "=== staged ==="
git --no-pager diff --cached --stat
