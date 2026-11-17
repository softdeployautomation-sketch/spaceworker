#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'bash -s' <<'REMOTE'
set -u
cd /opt/spaceworker
echo "=== 1. index.d.ts mtime + size ==="
stat -c '%y  %s bytes' node_modules/.prisma/client/index.d.ts
echo "=== 2. does index.d.ts mention ANY of the recently-added AdminSetting price fields? ==="
for field in xdevicePriceUsd cyberlabModulePriceUsd deviceMonitorExePriceUsd extractorModulePriceUsd; do
  echo -n "  $field: "; grep -c "$field" node_modules/.prisma/client/index.d.ts
done
echo "=== 3. Show the AdminSetting type block from generated client (first 40 field lines) ==="
awk '/export type AdminSetting = {/{f=1} f{print} f&&/^}/{exit}' node_modules/.prisma/client/index.d.ts | head -50
echo "=== 4. count total AdminSetting fields in generated vs schema ==="
echo -n "generated AdminSetting fields: "; awk '/export type AdminSetting = {/{f=1} f{print} f&&/^}/{c++} c&&/^}/{exit}' node_modules/.prisma/client/index.d.ts | grep -cE '^\s+[a-zA-Z]+.*:'
echo -n "schema AdminSetting fields: "; awk '/model AdminSetting /{f=1} f{print} f&&/^}/{exit}' prisma/schema.prisma | grep -cE '^\s+[a-zA-Z]+ '
REMOTE
