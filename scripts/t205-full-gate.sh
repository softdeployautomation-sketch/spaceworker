#!/usr/bin/env bash
# TASK_205 full gate: tsc, eslint on changed files, hosting tests.
cd /Users/mikeolab/spaceworker
echo "=== TSC ==="
npx tsc --noEmit 2>&1 | head -40
echo "TSC_EXIT=${PIPESTATUS[0]}"
echo "=== ESLINT ==="
npx eslint \
  'app/api/hosting/links/route.ts' \
  'app/api/hosting/links/[id]/route.ts' \
  'app/r/[token]/route.ts' \
  'lib/hosting/links.ts' \
  'lib/hosting/links-engine.ts' \
  'lib/hosting/workers.ts' \
  'components/hosting-panel.tsx' 2>&1 | head -40
echo "ESLINT_EXIT=${PIPESTATUS[0]}"
echo "=== HOSTING TESTS ==="
npx tsx --test tests/hosting-desktop-gate.test.ts tests/hosting-workers.test.ts 2>&1 | grep -E '^# (tests|pass|fail|skipped)|not ok' | head -40
echo "=== GATE DONE ==="
