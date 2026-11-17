#!/usr/bin/env bash
set -u
cd /Users/mikeolab/vantra
echo "=== eslint (3 touched files) ==="
npx eslint lib/meshcentral-api.ts "app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts" tests/mesh-share-console.test.ts
echo "ESLINT_EXIT=$?"
echo "=== tsc ==="
npx tsc --noEmit
echo "TSC_EXIT=$?"
echo "=== full suite ==="
npx tsx --test tests/*.test.ts 2>&1 | grep -E '^# (tests|pass|fail|skipped)'
