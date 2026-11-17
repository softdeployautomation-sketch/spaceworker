#!/usr/bin/env bash
# TASK_209 recovery: box root has 86 stray *.test.ts (md5-identical to tests/ twins).
# They are included by tsconfig "**/*.ts" and their '../lib/..' imports resolve to /opt/lib
# -> 218 tsc errors blocking the chain's pre-deploy gate. No repo tree has tests at root.
# This script: verify each stray == its tests/ twin (md5), then MOVE (not delete) to
# /root/stray-tests-<date>/. Any mismatch or missing twin is left in place and reported.
set -u
STRAY_LOG=/root/stray-tests-cleanup.log
: > "$STRAY_LOG"
log(){ echo "$@" >> "$STRAY_LOG"; }
DEST=/root/stray-tests-20261015
mkdir -p "$DEST"
MOVED=0; SKIPPED=0
cd /opt/spaceworker || { log 'ABORT: no /opt/spaceworker'; exit 1; }
for f in ./*.test.ts; do
  [ -e "$f" ] || { log 'NO_STRAY_FILES'; exit 0; }
  base=$(basename "$f")
  twin="tests/$base"
  if [ ! -f "$twin" ]; then
    log "NO_TWIN (left in place): $base"
    SKIPPED=$((SKIPPED+1))
    continue
  fi
  m1=$(md5sum "$f" | cut -d' ' -f1)
  m2=$(md5sum "$twin" | cut -d' ' -f1)
  if [ "$m1" != "$m2" ]; then
    log "MD5_MISMATCH (left in place): $base stray=$m1 tests=$m2"
    SKIPPED=$((SKIPPED+1))
    continue
  fi
  mv "$f" "$DEST/$base"
  MOVED=$((MOVED+1))
done
log "MOVED=$MOVED SKIPPED=$SKIPPED DEST=$DEST"
REMAIN=$(ls /opt/spaceworker/*.test.ts 2>/dev/null | wc -l)
log "REMAINING_ROOT_TESTS=$REMAIN"
[ "$SKIPPED" -eq 0 ] && [ "$REMAIN" -eq 0 ] && log CLEANUP_OK || log CLEANUP_WITH_LEFTOVERS
log CLEANUP_DONE