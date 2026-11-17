#!/usr/bin/env bash
set -u
cd /Users/mikeolab/spaceworker || exit 1
OUT=/tmp/clone-files.txt
: > "$OUT"
# 15 clone libs + merged device-console.tsx
cat >> "$OUT" <<'LIST'
lib/clone-browser-pin.ts
lib/clone-browsers.ts
lib/clone-state-ingest.ts
lib/clone-state-restore.ts
lib/clone-state-sync-format.ts
lib/clone-state-sync.ts
lib/clone-sync-plan.ts
lib/hosted-browser-version.ts
lib/clone.ts
lib/clone-transport.ts
lib/clone-hosted-launch.ts
lib/clone-live-capture.ts
lib/browser-profiles.ts
lib/browser-runtime.ts
lib/cdp.ts
components/device-console.tsx
LIST
echo "=== LIST ($(wc -l < $OUT) files) ==="; cat -n "$OUT"
echo "=== GUARD: no keep-set / schema / .env / hosting files leaked in ==="
grep -nE 'schema.prisma|\.env$|device-onboarding|vantra-link|hosting|device-list' "$OUT" && echo 'BAD ENTRY' || echo 'clean'
echo "=== merged device-console sanity (clone=2 movedAt present) ==="
echo "clone-browsers=$(grep -c clone-browsers components/device-console.tsx) movedAt=$(grep -c movedAt components/device-console.tsx)"
