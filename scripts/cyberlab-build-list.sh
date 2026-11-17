#!/usr/bin/env bash
set -u
cd /Users/mikeolab/sw-lab || exit 1
OUT=/tmp/cyberlab-files.txt
: > "$OUT"
# Directory trees (end with /)
echo 'app/cyberlab/' >> "$OUT"
echo 'app/api/cyberlab/' >> "$OUT"
echo 'app/api/admin/cyberlab/' >> "$OUT"
# Flat files per handoff section 3
for f in \
  lib/lab/engine.ts lib/lab/runner.ts lib/lab/range.ts lib/lab/scenarios.ts \
  lib/lab/episode.ts lib/lab/evidence.ts lib/lab/targets.ts lib/lab/targets-core.ts \
  lib/lab/victim-sensor.ts lib/lab/catalog-seed.ts lib/lab/console-map.ts \
  lib/resource-governor.ts \
  components/cyberlab-ops-console.tsx components/cyberlab-panel.tsx \
  components/admin-lab-runs-view.tsx \
  'app/admin=topsecret6199/(protected)/admin-panel.tsx' \
  app/globals.css prisma/schema.prisma scripts/cyberlab-dry-run.ts \
  package.json .gitignore \
  tests/lab-c2.test.ts tests/lab-c2b.test.ts tests/lab-ui1.test.ts tests/resource-governor.test.ts ; do
  echo "$f" >> "$OUT"
done
echo '=== LIST ==='
cat -n "$OUT"
echo '=== VALIDATE: every entry exists in sw-lab? ==='
miss=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  if [ "${line: -1}" = "/" ]; then
    if [ -d "$line" ]; then echo "DIR OK   $line"; else echo "DIR MISS $line"; miss=1; fi
  else
    if [ -f "$line" ]; then echo "FILE OK  $line"; else echo "FILE MISS $line"; miss=1; fi
  fi
done < "$OUT"
echo "=== missing_flag=$miss ==="
echo '=== GUARD: list must NOT contain device-console / clone-open-session / .env ==='
if grep -nE 'device-console|clone-open-session|\.env' "$OUT"; then echo 'BAD: forbidden entry present'; else echo 'clean: no forbidden entries'; fi
