#!/usr/bin/env bash
set -u
SW=/Users/mikeolab/spaceworker
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
cd "$SW" || exit 1
BASE=a1704b4a3f5d5d6d854a5c51ca580e8ead86e70b

echo "=== backup box device-console.tsx + engine-dist ==="
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cp -a /opt/spaceworker/components/device-console.tsx /root/device-console.tsx.bak-$(date +%s) && tar czf /root/engine-dist.bak-$(date +%s).tar.gz -C /opt/spaceworker engine-dist && ls -la /root/device-console.tsx.bak-* /root/engine-dist.bak-* | tail -4"

echo "=== extract 3 versions ==="
git show "$BASE:components/device-console.tsx" > /tmp/dc-base.tsx
git show "origin/main:components/device-console.tsx" > /tmp/dc-theirs.tsx
ssh -i "$KEY" -o BatchMode=yes "$HOST" "cat /opt/spaceworker/components/device-console.tsx" > /tmp/dc-ours.tsx
echo "lines: base=$(wc -l < /tmp/dc-base.tsx) ours(box)=$(wc -l < /tmp/dc-ours.tsx) theirs(main)=$(wc -l < /tmp/dc-theirs.tsx)"
echo "ours movedAt=$(grep -c movedAt /tmp/dc-ours.tsx) clone=$(grep -c clone-browsers /tmp/dc-ours.tsx) | theirs movedAt=$(grep -c movedAt /tmp/dc-theirs.tsx) clone=$(grep -c clone-browsers /tmp/dc-theirs.tsx)"

echo "=== 3-way merge: OURS(box/TASK206) + THEIRS(main/clone) on BASE ==="
cp /tmp/dc-ours.tsx /tmp/dc-merged.tsx
git merge-file -p /tmp/dc-merged.tsx /tmp/dc-base.tsx /tmp/dc-theirs.tsx > /tmp/dc-merged-out.tsx
rc=$?
echo "merge-file exit=$rc (0=clean, >0=#conflicts, <0=error)"
echo "conflict markers: $(grep -c '^<<<<<<<\|^=======\|^>>>>>>>' /tmp/dc-merged-out.tsx)"
echo "=== merged result sanity ==="
echo "merged movedAt=$(grep -c movedAt /tmp/dc-merged-out.tsx) clone=$(grep -c clone-browsers /tmp/dc-merged-out.tsx)"
cp /tmp/dc-merged-out.tsx "$SW/components/device-console.tsx"
echo "wrote merged to working tree components/device-console.tsx"
