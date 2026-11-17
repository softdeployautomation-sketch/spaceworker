#!/usr/bin/env bash
set -u
SW=/Users/mikeolab/spaceworker
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
cd "$SW" || exit 1

# The 7 missing clone libs + hosted-browser-version (self-contained clone code)
CLONELIBS="lib/clone-browser-pin.ts lib/clone-browsers.ts lib/clone-state-ingest.ts lib/clone-state-restore.ts lib/clone-state-sync-format.ts lib/clone-state-sync.ts lib/clone-sync-plan.ts lib/hosted-browser-version.ts"

echo "=== A. What named symbols do the clone libs import from CORE files the box has TASK206/TASK205 versions of? ==="
echo "    (devices.ts, env.ts, db.ts, prisma.ts)  — then check if those symbols EXIST on the box already"
python3 - "$SW" <<'PY'
import os,re,sys
ROOT=sys.argv[1]
CLONE=["lib/clone-browser-pin.ts","lib/clone-browsers.ts","lib/clone-state-ingest.ts",
 "lib/clone-state-restore.ts","lib/clone-state-sync-format.ts","lib/clone-state-sync.ts",
 "lib/clone-sync-plan.ts","lib/hosted-browser-version.ts"]
CORE={"lib/devices.ts","lib/env.ts","lib/db.ts","lib/prisma.ts"}
def resolve(imp,base):
    if imp.startswith("@/"): t=imp[2:]
    elif imp.startswith("."): t=os.path.normpath(os.path.join(base,imp))
    else: return None
    for e in ["",".ts",".tsx","/index.ts"]:
        if os.path.isfile(os.path.join(ROOT,t+e)): return t+e
    return None
# collect {corefile: set(symbols)} that clone libs import
want={}
for f in CLONE:
    p=os.path.join(ROOT,f)
    if not os.path.isfile(p): continue
    for m in re.finditer(r'import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(@/[^"]+|\.\.?/[^"]+)"', open(p).read()):
        r=resolve(m.group(2),os.path.dirname(f))
        if r in CORE:
            syms=[s.strip().split(" as ")[0].strip() for s in m.group(1).split(",") if s.strip()]
            want.setdefault(r,set()).update(syms)
for cf,syms in sorted(want.items()):
    print(f"\n{cf}: clone libs import -> {sorted(syms)}")
PY

echo ""
echo "=== B. Do those symbols exist in the BOX's CURRENT versions? (if yes -> no core redeploy needed) ==="
for core in lib/devices.ts lib/env.ts lib/db.ts lib/prisma.ts; do
  echo "--- box $core: exported symbols ---"
  ssh -i "$KEY" -o BatchMode=yes "$HOST" "grep -oE 'export (async )?(function|const|class|type|interface) [A-Za-z0-9_]+' /opt/spaceworker/$core 2>/dev/null | sed -E 's/.* //' | sort -u | tr '\n' ' '; echo"
done
