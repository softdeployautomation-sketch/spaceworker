#!/usr/bin/env bash
set -u
cd /Users/mikeolab/spaceworker
echo "=== 1. touch-controls tests ==="
npx tsx --test tests/agent-touch-controls.test.ts 2>&1 | grep -E '^# (tests|pass|fail|skipped)'
echo "=== 2. tsc --noEmit (split by owner) ==="
npx tsc --noEmit > /tmp/t208-tsc.txt 2>&1 || true
# Pre-existing, NOT mine: the uncommitted clone-resync WIP device-console.tsx
# references movedAt, which origin/main's lib/device-onboarding.ts lacks (task-206
# deployed but never merged to main). That WIP must stay untouched.
mine=$(grep -c 'error TS' /tmp/t208-tsc.txt || true)
wip=$(grep -c 'components/device-console.tsx' /tmp/t208-tsc.txt || true)
echo "errors_total=$mine errors_in_clone_resync_wip_device_console=$wip"
if [ "$mine" != "$wip" ]; then echo "TSC_FAIL — non-WIP errors:"; grep 'error TS' /tmp/t208-tsc.txt | grep -v 'components/device-console.tsx' | head -20; fi
echo "=== 3. eslint: new pure files (must be 0) ==="
npx eslint lib/touch-controls.ts tests/agent-touch-controls.test.ts 2>&1 | tail -8
echo "=== 4. eslint: panel errors vs origin/main baseline ==="
npx eslint components/browser-session-panel.tsx 2>&1 | grep -E '^\s+[0-9]+:[0-9]+' | wc -l | xargs echo "current_total:"
git show origin/main:components/browser-session-panel.tsx > /tmp/t208-baseline.tsx
npx eslint --stdin --stdin-filename components/browser-session-panel.tsx < /tmp/t208-baseline.tsx 2>&1 | grep -E '^\s+[0-9]+:[0-9]+' | wc -l | xargs echo "baseline_total:"
echo "current errors detail:"
npx eslint components/browser-session-panel.tsx 2>&1 | grep -E '^\s+[0-9]+:[0-9]+'
