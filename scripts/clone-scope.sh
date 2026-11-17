#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
SW=/Users/mikeolab/spaceworker
cd "$SW" || exit 1

echo "########## 1. CLONE API ROUTES: box vs origin/main ##########"
echo "--- box app/api/clone ---"
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'find /opt/spaceworker/app/api/clone -name route.ts 2>/dev/null | sed "s#/opt/spaceworker/##" | sort' > /tmp/box-clone-routes.txt 2>/dev/null
echo "--- local origin/main app/api/clone ---"
git ls-tree -r --name-only origin/main -- app/api/clone | grep 'route.ts$' | sort > /tmp/local-clone-routes.txt 2>/dev/null
echo "box clone routes: $(wc -l < /tmp/box-clone-routes.txt), local: $(wc -l < /tmp/local-clone-routes.txt)"
echo "--- MISSING clone routes on box ---"
comm -13 /tmp/box-clone-routes.txt /tmp/local-clone-routes.txt

echo "########## 2. ENGINE-DIST: box vs local (relay binaries + install script) ##########"
echo "--- local engine-dist ---"
ls -la "$SW/engine-dist/" 2>/dev/null | awk '{print $5, $9}'
echo "--- box engine-dist ---"
ssh -i "$KEY" -o BatchMode=yes "$HOST" 'ls -la /opt/spaceworker/engine-dist/ 2>/dev/null | awk "{print \$5, \$9}"'
echo "--- hash compare key relay files ---"
for f in hack-relay.exe install-relay.ps1; do
  lh=$(shasum -a 256 "$SW/engine-dist/$f" 2>/dev/null | awk '{print $1}')
  bh=$(ssh -i "$KEY" -o BatchMode=yes "$HOST" "sha256sum /opt/spaceworker/engine-dist/$f 2>/dev/null | awk '{print \$1}'")
  [ "$lh" = "$bh" ] && echo "MATCH   $f" || echo "DIFFERS $f (local=${lh:0:12} box=${bh:0:12})"
done

echo "########## 3. device-console.tsx: box(current, TASK206) vs origin/main(clone) ##########"
echo -n "box imports clone-browsers: "
ssh -i "$KEY" -o BatchMode=yes "$HOST" "grep -c clone-browsers /opt/spaceworker/components/device-console.tsx"
echo -n "box has task206 movedAt threading: "
ssh -i "$KEY" -o BatchMode=yes "$HOST" "grep -c movedAt /opt/spaceworker/components/device-console.tsx"
echo -n "origin/main imports clone-browsers: "
git show origin/main:components/device-console.tsx | grep -c clone-browsers
echo -n "origin/main has movedAt: "
git show origin/main:components/device-console.tsx | grep -c movedAt
echo "(=> blind resync of device-console.tsx from origin/main would DROP task206 movedAt)"

echo "########## 4. clone backend import-closure: do the 7 missing libs need anything not on box? ##########"
python3 - "$SW" <<'PY'
import os,re,sys
ROOT=sys.argv[1]
behind=set(l.strip() for l in open("/tmp/box_behind.txt") if l.strip())
missing7=["lib/clone-browser-pin.ts","lib/clone-browsers.ts","lib/clone-state-ingest.ts",
 "lib/clone-state-restore.ts","lib/clone-state-sync-format.ts","lib/clone-state-sync.ts","lib/clone-sync-plan.ts"]
def resolve(imp,base):
    if imp.startswith("@/"): t=imp[2:]
    elif imp.startswith("."): t=os.path.normpath(os.path.join(base,imp))
    else: return None
    for e in ["",".ts",".tsx","/index.ts"]:
        if os.path.isfile(os.path.join(ROOT,t+e)): return t+e
    return None
# full transitive closure from the 7
seen=set(); q=list(missing7); needs=set()
while q:
    f=q.pop()
    if f in seen: continue
    seen.add(f)
    p=os.path.join(ROOT,f)
    if not os.path.isfile(p): continue
    for m in re.finditer(r'from "(@/[^"]+|\.\.?/[^"]+)"',open(p).read()):
        r=resolve(m.group(1),os.path.dirname(f))
        if not r: continue
        if r in behind: needs.add(r)
        q.append(r)
print("clone-cluster closure pulls these box-behind files (must co-deploy):")
for r in sorted(needs): print("   ",r)
if not needs: print("   (none beyond the 7 themselves)")
PY
