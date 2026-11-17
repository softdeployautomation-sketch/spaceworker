#!/usr/bin/env bash
set -u
cd /Users/mikeolab/sw-lab || exit 1
# @/ imports referenced but NOT in my deploy list -> must already exist on LIVE box
cat > /tmp/cy_need.txt <<'LIST'
@/components/cyberlab-aup
@/components/module-tool-lock
@/lib/admin-auth
@/lib/admin-settings
@/lib/auth
@/lib/db
@/lib/lab/consent
@/lib/lab/gate
@/lib/lab/research
@/lib/lab/tools
@/lib/module-gate
@/lib/prisma
@/lib/session-user
@/lib/entitlements
@/lib/devices
LIST
echo '=== do these exist LOCALLY in sw-lab (sanity: they should, since sw-lab compiles)? ==='
for spec in $(cat /tmp/cy_need.txt); do
  rel="${spec#@/}"
  if ls "${rel}".ts "${rel}".tsx "${rel}"/index.ts >/dev/null 2>&1; then
    echo "LOCAL OK   $spec"
  else
    echo "LOCAL MISS $spec"
  fi
done
echo
echo '=== do they exist on the LIVE box? ==='
for spec in $(cat /tmp/cy_need.txt); do
  rel="${spec#@/}"
  res=$(ssh -i ~/.ssh/tacticalrmm_vps -o BatchMode=yes root@164.68.105.96 \
    "cd /opt/spaceworker && ls ${rel}.ts ${rel}.tsx ${rel}/index.ts 2>/dev/null | head -1")
  if [ -n "$res" ]; then echo "LIVE OK    $spec -> $res"; else echo "LIVE MISS  $spec  <<< BUILD WOULD BREAK"; fi
done
