#!/usr/bin/env bash
# TASK_209 recovery step 2: audit box tests/ lineage vs repo, restore 7055cf3 copies.
# Discovery: 5 root strays differed from their tests/ twins; forensics showed the BOX
# tests/ copies are the odd ones (3 match NO branch; resource-governor=lab, support-
# tickets=209 vs stray=lab). This script:
#  1) builds md5 manifests for tests/ from 7055cf3 (209) and 12ff9a8 (lab) locally
#  2) ships them to the box and classifies every box tests/*.test.ts
#  3) restores box copies that differ from 7055cf3 EXCEPT lab-owned extras
#     (files that exist only in the lab tree and match 12ff9a8 -> keep)
#  4) moves the 5 remaining root *.test.ts strays into /root/stray-tests-20261015/
# Log: /tmp/t209-tests-audit.txt (local) + /root/t209-tests-audit-box.log (box)
set -u
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/t209-tests-audit.txt
: > "$OUT"
log(){ echo "$@" >> "$OUT"; }
REPO=/Users/mikeolab/spaceworker
cd "$REPO" || exit 1

log '=== [1] manifests ==='
for f in $(git ls-tree --name-only 7055cf3 tests/ | grep '\.test\.ts$'); do echo "$(basename "$f") $(git show 7055cf3:"$f" | md5 -q)"; done | sort > /tmp/man-209.txt
for f in $(git ls-tree --name-only 12ff9a8 tests/ | grep '\.test\.ts$'); do echo "$(basename "$f") $(git show 12ff9a8:"$f" | md5 -q)"; done | sort > /tmp/man-lab.txt
log "209_files=$(wc -l < /tmp/man-209.txt) lab_files=$(wc -l < /tmp/man-lab.txt)"

log '=== [2] ship manifests + audit on box ==='
scp -i "$K" -q /tmp/man-209.txt /tmp/man-lab.txt root@164.68.105.96:/root/ || { log ABORT_SCP; exit 1; }
ssh -i "$K" root@164.68.105.96 'bash -s' >> "$OUT" 2>&1 <<'BOX'
set -u
LOG=/root/t209-tests-audit-box.log
: > "$LOG"
log(){ echo "$@" >> "$LOG"; }
cd /opt/spaceworker/tests || exit 1
RESTORE=""
KEEP_LAB=0
OK209=0
for f in *.test.ts; do
  m=$(md5sum "$f" | cut -d' ' -f1)
  m209=$(grep "^$f " /root/man-209.txt | cut -d' ' -f2)
  mlab=$(grep "^$f " /root/man-lab.txt | cut -d' ' -f2)
  if [ -n "$m209" ] && [ "$m" = "$m209" ]; then OK209=$((OK209+1)); continue; fi
  if [ -z "$m209" ] && [ -n "$mlab" ] && [ "$m" = "$mlab" ]; then
    log "LAB_EXTRA_KEPT $f $m"; KEEP_LAB=$((KEEP_LAB+1)); continue
  fi
  if [ -n "$mlab" ] && [ "$m" = "$mlab" ]; then
    log "WRONG_LAB_COPY $f box=$m -> restore 209"; RESTORE="$RESTORE $f"; continue
  fi
  log "UNKNOWN_COPY $f box=$m 209=$m209 lab=$mlab -> restore 209"; RESTORE="$RESTORE $f"
done
log "OK209=$OK209 KEEP_LAB=$KEEP_LAB RESTORE_COUNT=$(echo $RESTORE | wc -w)"
echo "RESTORE_LIST:$RESTORE" >> "$LOG"
tail -3 "$LOG"
BOX
grep -E '^(OK209|WRONG_LAB|UNKNOWN|LAB_EXTRA)' "$OUT" | tail -20

log '=== [3] done (restore shipping happens in t209-tests-restore.sh) ==='
log AUDIT_DONE