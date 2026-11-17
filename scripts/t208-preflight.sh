#!/usr/bin/env bash
set -u
cd /Users/mikeolab/spaceworker
K='tacticalrmm_vps'
B='root@164.68.105.96'
echo '=== 1. branch + status ==='
git branch --show-current
git status --short | head -8
echo '=== 2. touch-controls.ts imports (sibling closure) ==='
grep -n '^import' lib/touch-controls.ts || echo '(no imports - self-contained)'
echo '=== 3. @/lib imports in browser-session-panel (must all ship) ==='
grep -n 'from "@/lib/' components/browser-session-panel.tsx | head -10
echo '=== 4. surviving string literal marker (for built-chunk grep) ==='
grep -oE 'sw-touch[a-zA-Z-]*|touchKeyboard[A-Za-z]*' components/browser-session-panel.tsx lib/touch-controls.ts | sort -u | head -8
echo '=== 5. BOX pre-state ==='
ssh -i ~/.ssh/$K -o BatchMode=yes -o ConnectTimeout=10 $B 'echo -n "  panel on box:  "; sha256sum /opt/spaceworker/components/browser-session-panel.tsx 2>/dev/null | cut -c1-16 || echo MISSING; echo -n "  touch on box:  "; sha256sum /opt/spaceworker/lib/touch-controls.ts 2>/dev/null | cut -c1-16 || echo MISSING; echo -n "  box panel imports touch-controls: "; grep -c "touch-controls" /opt/spaceworker/components/browser-session-panel.tsx 2>/dev/null || echo 0'
echo '=== 6. LOCAL (working tree) + origin/main hashes ==='
echo -n "  local   : "; shasum -a 256 components/browser-session-panel.tsx | cut -c1-16
echo -n "  origin  : "; git show origin/main:components/browser-session-panel.tsx | shasum -a 256 | cut -c1-16
echo '=== 7. BUILD_ID before ==='
ssh -i ~/.ssh/$K -o BatchMode=yes $B 'cat /opt/spaceworker/.next/BUILD_ID; echo'
