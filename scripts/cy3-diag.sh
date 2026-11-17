#!/usr/bin/env bash
set -u
SSH="ssh -i $HOME/.ssh/tacticalrmm_vps -o BatchMode=yes -o ConnectTimeout=15"
HOST=root@164.68.105.96

echo '=== [D1] generateBuildId in next.config (local sw-lab + spaceworker) ==='
grep -n -A4 'generateBuildId' /Users/mikeolab/sw-lab/next.config.* 2>/dev/null | head -10 || echo 'sw-lab: none (default random)'
grep -n -A4 'generateBuildId' /Users/mikeolab/spaceworker/next.config.* 2>/dev/null | head -10 || echo 'spaceworker: none (default random)'

echo '=== [D2] box .next mtimes + prev ==='
$SSH "$HOST" 'stat -c "%y %n" /opt/spaceworker/.next/BUILD_ID /opt/spaceworker/.next 2>/dev/null; ls -d /opt/spaceworker/.next.prev 2>/dev/null || echo "no .next.prev"; date -u +"box now: %Y-%m-%dT%H:%M:%SZ"'

echo '=== [D3] exact CTA string in box module-tool-lock source ==='
$SSH "$HOST" 'grep -n "Add Cyber Lab" /opt/spaceworker/components/module-tool-lock.tsx | head -3; grep -rn "Request for Cyber Lab" /opt/spaceworker/lib/support-templates.ts | head -2'

echo '=== [D4] built-chunk search: looser string ==='
$SSH "$HOST" 'cd /opt/spaceworker/.next; grep -rl "Add Cyber Lab" static/chunks/ 2>/dev/null | head -5; echo "---count---"; grep -rl "Add Cyber Lab" static/chunks/ 2>/dev/null | wc -l'

echo '=== [D5] the 1 journal error line ==='
$SSH "$HOST" 'journalctl -u spaceworker --since "12 min ago" --no-pager 2>/dev/null | grep -i "error\|unhandled" | tail -3'
echo DONE
