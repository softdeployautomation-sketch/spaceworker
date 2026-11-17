#!/usr/bin/env bash
set -euo pipefail
cd /Users/mikeolab/spaceworker
OUT=/tmp/task205-anchors.txt
: > "$OUT"
{
echo "===== schema: model LinkRedirect ====="
awk '/model LinkRedirect /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma
echo; echo "===== links.ts anchors ====="
grep -n 'desktopOnlyInterstitialHtml\|resolveLink\|canUseDesktopOnlyGate\|toHostedLinkView\|isMobileUserAgent\|createHostedLink\|updateHostedLink\|isValidLinkTarget\|HostedLinkView\|ResolvedLink\|LinkRedirectRow\|desktopOnly' lib/hosting/links.ts
echo; echo "===== workers.ts anchors ====="
grep -n 'WORKER_DESKTOP_GATE_SNIPPET\|buildWorkerMapSource\|WorkerMapEntry\|desktopOnly\|const MAP\|const DESKTOP\|t175IsMobile\|const W\b' lib/hosting/workers.ts
echo; echo "===== links-engine.ts anchors ====="
grep -n 'mapEntriesFor\|desktopOnly\|token\|slug\|target\|customHost\|select' lib/hosting/links-engine.ts
echo; echo "===== rules.ts isValidLinkTarget ====="
grep -n 'export function isValidLinkTarget' lib/hosting/rules.ts
echo; echo "===== hosting-panel.tsx anchors ====="
grep -n 'desktopOnly\|Desktop only\|Desktop-only\|desktopOnlyAllowed\|Edit wording\|Split by device\|mobileTarget' components/hosting-panel.tsx
echo; echo "===== existing tests ====="
ls tests/ | grep -iE 'hosting|link|worker|desktop|redirect' || echo '(none)'
echo; echo "===== test scripts ====="
grep -nE '"(test|test:[a-z]+)"' package.json
} >> "$OUT" 2>&1
echo WROTE "$OUT"
