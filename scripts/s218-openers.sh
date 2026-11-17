#!/usr/bin/env bash
# TASK_218 B1 — H7 opener audit: find EVERY way a browser session can be opened
# in a new tab / iframe, and classify bare-Neko-URL vs popoutHrefFor.
set -uo pipefail
cd /Users/mikeolab/spaceworker
OUT=/Users/mikeolab/spaceworker/scripts/s218-openers.out
{
  echo "=== H7-1: popoutHrefFor / browser-popout references (all files) ==="
  grep -rn "popoutHrefFor\|browser-popout" --include=*.ts --include=*.tsx . \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git || echo "(none)"
  echo
  echo "=== H7-2: window.open( ==="
  grep -rn "window\.open(" --include=*.tsx --include=*.ts . \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git || echo "(none)"
  echo
  echo "=== H7-3: target=\"_blank\" / target='_blank' ==="
  grep -rn 'target="_blank"\|target=._blank' --include=*.tsx --include=*.ts . \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git || echo "(none)"
  echo
  echo "=== H7-4: connectUrl / connectUrlFor / serializeSession users ==="
  grep -rln "connectUrl" --include=*.tsx --include=*.ts . \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git || echo "(none)"
  echo
  echo "=== H7-5: neko URL /usr=/pwd= minting ==="
  grep -rn "browser-session-serialize\|connectUrlFor\|serializeSession" --include=*.tsx --include=*.ts . \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git || echo "(none)"
  echo
  echo "=== D1 grounding: RemoteViewerControls mounts ==="
  grep -rn "RemoteViewerControls" --include=*.tsx --exclude-dir=node_modules --exclude-dir=.next . || echo "(none)"
} > "$OUT" 2>&1
echo "WROTE $OUT ($(wc -l < "$OUT") lines)"
