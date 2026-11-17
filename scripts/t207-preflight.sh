#!/usr/bin/env bash
set -u
SSH="ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96"

echo "=== A. VANTRA service + build on box ==="
$SSH 'systemctl is-active vantra 2>/dev/null || systemctl list-units --type=service | grep -i vantra | head -3; echo "BUILD_ID=$(cat /opt/vantra/.next/BUILD_ID 2>/dev/null)"; curl -s -o /dev/null -w "vantra:3300 = %{http_code}\n" --max-time 8 http://localhost:3300/ || true'

echo "=== B. Vantra mint route on box: scope handling present? (expect ABSENT = not deployed) ==="
$SSH 'f="/opt/vantra/app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts"; grep -c "scope" "$f" 2>/dev/null; grep -n "scope\b" "$f" 2>/dev/null | head -5'

echo "=== C. hashes: vantra 2 edited files (box vs local) ==="
for f in "lib/meshcentral-api.ts" "app/api/internal/sw/devices/[agentId]/mesh-urls/route.ts"; do
  lb=$(git -C /Users/mikeolab/vantra rev-parse "HEAD:./$f" 2>/dev/null || echo NOGIT)
  lf=$(shasum -a 256 "/Users/mikeolab/vantra/$f" | cut -d' ' -f1)
  rf=$($SSH "shasum -a 256 '/opt/vantra/$f' 2>/dev/null | cut -d' ' -f1" | tr -d '\r\n')
  echo "$f local_disk=$lf box=$rf"
done

echo "=== D. hashes: spaceworker 3 runtime files (box vs local) ==="
for f in "components/device-console.tsx" "lib/device-tools.ts" "lib/device-onboarding.ts"; do
  lf=$(shasum -a 256 "/Users/mikeolab/spaceworker/$f" | cut -d' ' -f1)
  rf=$($SSH "shasum -a 256 '/opt/spaceworker/$f' 2>/dev/null | cut -d' ' -f1" | tr -d '\r\n')
  echo "$f local=$lf box=$rf"
done

echo "=== E. device-console on box == my branch's PARENT content (clone WIP e1314a8)? ==="
cd /Users/mikeolab/spaceworker
git show e1314a8:components/device-console.tsx | shasum -a 256 | cut -d' ' -f1
echo "(compare with box hash in D: equal => box predates only my S2 diff => safe)"

echo "=== F. device-tools: full diff box -> local (BOX-ONLY line check) ==="
$SSH 'cat "/opt/spaceworker/lib/device-tools.ts"' > /tmp/box-device-tools.ts 2>/dev/null
diff /tmp/box-device-tools.ts /Users/mikeolab/spaceworker/lib/device-tools.ts > /tmp/dt-diff.txt; echo "diff exit=$? (0=identical)"
echo "--- hunks: ---"
grep -E '^[0-9]' /tmp/dt-diff.txt | head -20
echo "--- box-only lines (in box NOT local, = regression risk if rsynced) ---"
grep '^<' /tmp/dt-diff.txt | head -20

echo "=== G. device-onboarding: box == 206 branch? (decides EXCLUDE) ==="
b=$(shasum -a 256 /tmp/box-do-doesnotexist 2>/dev/null)
$SSH 'shasum -a 256 /opt/spaceworker/lib/device-onboarding.ts | cut -d" " -f1'
git -C /Users/mikeolab/spaceworker show agent/task-206-quarantine-rework:lib/device-onboarding.ts | shasum -a 256 | cut -d' ' -f1

echo "=== H. spaceworker current BUILD_ID + health ==="
$SSH 'echo "BUILD_ID=$(cat /opt/spaceworker/.next/BUILD_ID)"; curl -s -o /dev/null -w "sw:3500 = %{http_code}\n" --max-time 8 http://localhost:3500/'
echo "=== PREFLIGHT DONE ==="
