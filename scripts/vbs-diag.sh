#!/usr/bin/env bash
# Diagnose the .vbs hosting regression: where the error lives, when the
# allowance landed, whether any deploy today touched that file.
set -u
cd /Users/mikeolab/spaceworker || exit 1
OUT=/tmp/vbs-diag.txt

{
echo '=== [1] error string source ==='
grep -rn "hosted as downloads" lib app components 2>/dev/null | head -5

echo '=== [2] .vbs refs in lib/hosting ==='
grep -rn -i 'vbs' lib/hosting 2>/dev/null | head -10

echo '=== [3] commits touching the .vbs/all-files allowance ==='
git log --all -S 'vbs' --oneline --date=short --format='%h %ad %s' -- lib/hosting 2>/dev/null | head -10

echo '=== [4] does origin/main have the allowance? ==='
for f in $(grep -rln "hosted as downloads" lib/hosting 2>/dev/null); do
  echo "--- $f ---"
  echo "origin/main vbs count: $(git show origin/main:$f 2>/dev/null | grep -ci vbs)"
  echo "HEAD        vbs count: $(git show HEAD:$f 2>/dev/null | grep -ci vbs)"
  echo "t205branch  vbs count: $(git show agent/task-205-link-routing-wording:$f 2>/dev/null | grep -ci vbs)"
  echo "t207branch  vbs count: $(git show agent/task-207-console-scope:$f 2>/dev/null | grep -ci vbs)"
done

echo '=== [5] which deploy lists shipped that file since yesterday? ==='
for f in $(grep -rln "hosted as downloads" lib/hosting 2>/dev/null); do
  echo "--- $f in t207 sw list? ---"
  grep -Fx "$f" /tmp/t207-sw-files.txt 2>/dev/null || echo 'not in t207 list'
  echo "--- $f in cy3 list? ---"
  grep -Fx "$f" /tmp/cy3-files.txt 2>/dev/null || echo 'not in cy3 list'
done

echo '=== [6] box copy: mtime + allowance ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
for f in $(grep -rl "hosted as downloads" /opt/spaceworker/lib/hosting/ 2>/dev/null); do
  echo "file: $f"
  stat -c "mtime: %y" "$f"
  echo "vbs refs on box: $(grep -ci vbs "$f")"
done'

echo '=== [7] cy3 build actually landed? (NEW route in running manifest) ==='
ssh -i "$HOME/.ssh/tacticalrmm_vps" -o BatchMode=yes -o ConnectTimeout=15 root@164.68.105.96 '
grep -c "invoices" /opt/spaceworker/.next/server/app-path-routes-manifest.json 2>/dev/null || echo manifest-missing
ls -la /opt/spaceworker/.next.prev 2>/dev/null || echo no-next-prev'
echo DONE
} > "$OUT" 2>&1
echo WROTE "$OUT"
