#!/usr/bin/env bash
# TASK_209 recovery step 3: force-move the 5 remaining root *.test.ts strays whose
# tests/ twins differ (lineage drift between box tests/ and box root copies — audit
# t209-tests-audit.sh). tests/ itself typechecks clean (0 errors in tsc-final.log),
# so these root copies are pure leftovers: move them to the backup dir, record md5s.
set -u
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/t209-strays-force.txt
: > "$OUT"
log(){ echo "$@" >> "$OUT"; }
log '=== force-move remaining root test strays ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 'bash -s' >> "$OUT" 2>&1 <<'BOX'
set -u
DEST=/root/stray-tests-20261015
mkdir -p "$DEST"
for f in /opt/spaceworker/*.test.ts; do
  [ -e "$f" ] || break
  b=$(basename "$f")
  m=$(md5sum "$f" | cut -d' ' -f1)
  t=$(md5sum "/opt/spaceworker/tests/$b" 2>/dev/null | cut -d' ' -f1)
  echo "MOVING $b root_md5=$m tests_md5=${t:-NO_TWIN}" >> /root/stray-tests-cleanup.log
  mv "$f" "$DEST/$b"
done
echo "REMAINING=$(ls /opt/spaceworker/*.test.ts 2>/dev/null | wc -l)"
echo "BACKUP_COUNT=$(ls "$DEST" | wc -l)"
echo FORCE_DONE
BOX
log "$(tail -3 "$OUT")"
[ "$(grep -c REMAINING=0 "$OUT")" -gt 0 ] && log STRAYS_ALL_GONE || log STRAYS_REMAIN
log FORCE_DONE