#!/usr/bin/env bash
# TASK_209 restore: cy3-files clobbered mailer-exe-owned files. Restore ALL of them,
# then typecheck the whole box tree to catch any other inconsistency BEFORE burning a build.
set -u
cd /Users/mikeolab/spaceworker
K="$HOME/.ssh/tacticalrmm_vps"
OUT=/tmp/t209-restore.txt
{
echo '=== [1] blast radius: files in cy3 list that mailer-exe also owns ==='
git diff --name-only origin/main origin/mailer-exe 2>/dev/null | sort > /tmp/mailer-files.txt
sort -u /tmp/cy3-files.txt 2>/dev/null > /tmp/cy3-files-sorted.txt
comm -12 /tmp/mailer-files.txt /tmp/cy3-files-sorted.txt > /tmp/clobber-candidates.txt
wc -l < /tmp/clobber-candidates.txt
cat /tmp/clobber-candidates.txt

echo '=== [2] classify each: box vs sw-lab vs mailer-exe md5 ==='
mkdir -p /root-placeholder 2>/dev/null || true
: > /tmp/clobber-fix-list.txt
while IFS= read -r f; do
  [ -f "/Users/mikeolab/sw-lab/$f" ] || continue
  git show "origin/mailer-exe:$f" > /tmp/_mailer-copy.tmp 2>/dev/null || continue
  M=$(md5 -q /tmp/_mailer-copy.tmp)
  S=$(md5 -q "/Users/mikeolab/sw-lab/$f")
  B=$(ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96 "md5sum '/opt/spaceworker/$f' 2>/dev/null | cut -d' ' -f1")
  echo "$f | box=$B swlab=$S mailer=$M"
  if [ "$B" = "$S" ] && [ "$S" != "$M" ]; then
    echo "$f" >> /tmp/clobber-fix-list.txt
    echo "   -> CLOBBERED (box==swlab != mailer): RESTORE mailer-exe version"
  fi
done < /tmp/clobber-candidates.txt

echo '=== [3] restore every clobbered file from mailer-exe ==='
N=$(wc -l < /tmp/clobber-fix-list.txt)
echo "files to restore: $N"
mkdir -p /tmp/restore-files 2>/dev/null || true
while IFS= read -r f; do
  mkdir -p "/tmp/restore-files/$(dirname "$f")"
  git show "origin/mailer-exe:$f" > "/tmp/restore-files/$f"
  # backup the clobbered box copy, then push mailer's version
  ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96 \
    "mkdir -p /root/clobber-backup-t209 && cp '/opt/spaceworker/$f' '/root/clobber-backup-t209/$(echo "$f" | tr / _)' && echo backed-up-$f"
  scp -i "$K" -o BatchMode=yes -o ConnectTimeout=10 "/tmp/restore-files/$f" "root@164.68.105.96:/opt/spaceworker/$f"
  ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=10 root@164.68.105.96 \
    "chown trmm:trmm '/opt/spaceworker/$f' && echo restored-$f"
done < /tmp/clobber-fix-list.txt

echo '=== [4] full box typecheck (detached on box; poll /root/tsc-after-fix.log) ==='
ssh -i "$K" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 \
  "cd /opt/spaceworker && rm -f /root/tsc-after-fix.log
   nohup bash -c 'cd /opt/spaceworker && sudo -u trmm npx --no-install tsc --noEmit > /root/tsc-after-fix.log 2>&1; echo TSC_EXIT=\$? >> /root/tsc-after-fix.log' >/dev/null 2>&1 & echo tsc-launched"
echo RESTORE_DONE
} > "$OUT" 2>&1