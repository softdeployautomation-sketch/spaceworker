#!/usr/bin/env bash
set -u
# Find every origin/main file the LIVE box is missing or has stale, that the
# cyberlab build might need. Compares the box's lib/ components/ app/ trees
# against sw-lab (== origin/main for these paths) by content hash.
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
SW=/Users/mikeolab/sw-lab

# Build local hash list for the trees the build touches
cd "$SW" || exit 1
for tree in lib components; do
  find "$tree" -type f \( -name '*.ts' -o -name '*.tsx' \) | LC_ALL=C sort | while read -r f; do
    h=$(shasum -a 256 "$f" | awk '{print $1}')
    echo "$h  $f"
  done
done > /tmp/sw_hashes.txt

# Get remote hash list for the same trees
ssh -i "$KEY" -o BatchMode=yes "$HOST" \
  "cd /opt/spaceworker && find lib components -type f \\( -name '*.ts' -o -name '*.tsx' \\) | LC_ALL=C sort | while read -r f; do h=\$(sha256sum \"\$f\" | awk '{print \$1}'); echo \"\$h  \$f\"; done" > /tmp/box_hashes.txt 2>/dev/null

echo "=== total local files: $(wc -l < /tmp/sw_hashes.txt), box files: $(wc -l < /tmp/box_hashes.txt) ==="
echo
echo "=== FILES THAT DIFFER (content hash mismatch) — stale on box or missing ==="
# compare by path, report path if hash differs or file missing on box
awk '{print $2}' /tmp/sw_hashes.txt | LC_ALL=C sort > /tmp/sw_paths.txt
awk '{print $2}' /tmp/box_hashes.txt | LC_ALL=C sort > /tmp/box_paths.txt

# For each local file, find its box hash (if any) and compare
while read -r h f; do
  bh=$(grep -F "  $f" /tmp/box_hashes.txt | awk '{print $1}' | head -1)
  if [ -z "$bh" ]; then
    echo "MISSING_ON_BOX  $f"
  elif [ "$bh" != "$h" ]; then
    echo "STALE_ON_BOX    $f"
  fi
done < /tmp/sw_hashes.txt
