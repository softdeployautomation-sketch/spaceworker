#!/usr/bin/env bash
set -u
# TASK_205 deploy file list. EXCLUDES prisma/schema.prisma (handled via MERGED schema
# to preserve cyberlab sourceDeviceId). Includes the migration dir as a tree entry.
cd /Users/mikeolab/spaceworker || exit 1
OUT=/tmp/t205-files.txt
: > "$OUT"
echo 'prisma/migrations/20261122000000_task205_link_routing_and_wording/' >> "$OUT"
for f in \
  lib/hosting/links.ts \
  lib/hosting/links-engine.ts \
  lib/hosting/workers.ts \
  app/r/[token]/route.ts \
  components/hosting-panel.tsx \
  'app/api/hosting/links/[id]/route.ts' \
  'app/api/hosting/links/route.ts' \
  tests/hosting-desktop-gate.test.ts ; do
  echo "$f" >> "$OUT"
done
echo '=== LIST ==='; cat -n "$OUT"
echo '=== VALIDATE each exists on branch ==='
miss=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if [ "${line: -1}" = "/" ]; then
    [ -d "$line" ] && echo "DIR OK   $line" || { echo "DIR MISS $line"; miss=1; }
  else
    [ -f "$line" ] && echo "FILE OK  $line" || { echo "FILE MISS $line"; miss=1; }
  fi
done < "$OUT"
echo "missing_flag=$miss"
echo '=== GUARD: schema.prisma must NOT be in this list (merged separately) ==='
grep -nE 'schema.prisma|\.env|device-console|clone' "$OUT" && echo 'BAD entry' || echo 'clean (no schema.prisma/.env/clone)'
