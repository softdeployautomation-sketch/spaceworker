#!/usr/bin/env bash
set -u
SW=/Users/mikeolab/spaceworker
cd "$SW" || exit 1

# Files the box must KEEP (TASK206/TASK205 deployed versions, ahead of origin/main).
# Redeploying origin/main versions of these would REGRESS live features.
KEEP="lib/devices.ts lib/device-onboarding.ts lib/vantra-link.ts app/api/internal/device-onboarding-sweep/route.ts components/device-list.tsx lib/hosting/links.ts lib/hosting/links-engine.ts lib/hosting/workers.ts lib/hosting/rules.ts app/r/[token]/route.ts components/hosting-panel.tsx prisma/schema.prisma lib/db.ts lib/env.ts lib/prisma.ts"

# Clone-cluster files to pull from origin/main into the working tree.
CLONE_FILES="lib/clone-browser-pin.ts lib/clone-browsers.ts lib/clone-state-ingest.ts lib/clone-state-restore.ts lib/clone-state-sync-format.ts lib/clone-state-sync.ts lib/clone-sync-plan.ts lib/hosted-browser-version.ts lib/clone.ts lib/clone-transport.ts lib/clone-hosted-launch.ts lib/clone-live-capture.ts lib/browser-profiles.ts lib/browser-runtime.ts lib/cdp.ts"

echo "=== 1. pull clone libs from origin/main into working tree ==="
for f in $CLONE_FILES; do
  git checkout origin/main -- "$f" 2>/dev/null && echo "  got $f" || echo "  MISS on origin/main: $f"
done

echo "=== 2. install merged device-console.tsx (clone UI + movedAt) ==="
cp /tmp/dc-final.tsx components/device-console.tsx && echo "  installed merged device-console.tsx"

echo "=== 3. compute import closure of {device-console + clone libs}, cross-ref box_behind, EXCLUDE keep-set ==="
python3 - "$SW" <<'PY'
import os,re,sys
ROOT=sys.argv[1]
behind=set(l.strip() for l in open("/tmp/box_behind.txt") if l.strip())
keep=set("""lib/devices.ts lib/device-onboarding.ts lib/vantra-link.ts app/api/internal/device-onboarding-sweep/route.ts components/device-list.tsx lib/hosting/links.ts lib/hosting/links-engine.ts lib/hosting/workers.ts lib/hosting/rules.ts app/r/[token]/route.ts components/hosting-panel.tsx prisma/schema.prisma lib/db.ts lib/env.ts lib/prisma.ts""".split())
seeds=["components/device-console.tsx","lib/clone-browser-pin.ts","lib/clone-browsers.ts","lib/clone-state-ingest.ts","lib/clone-state-restore.ts","lib/clone-state-sync-format.ts","lib/clone-state-sync.ts","lib/clone-sync-plan.ts","lib/hosted-browser-version.ts","lib/clone.ts","lib/clone-transport.ts","lib/clone-hosted-launch.ts","lib/clone-live-capture.ts","lib/browser-profiles.ts","lib/browser-runtime.ts","lib/cdp.ts"]
def resolve(imp,base):
    if imp.startswith("@/"): t=imp[2:]
    elif imp.startswith("."): t=os.path.normpath(os.path.join(base,imp))
    else: return None
    for e in ["",".ts",".tsx","/index.ts","/index.tsx"]:
        if os.path.isfile(os.path.join(ROOT,t+e)): return t+e
    return None
seen=set(); q=list(seeds); need=set()
while q:
    f=q.pop()
    if f in seen: continue
    seen.add(f)
    p=os.path.join(ROOT,f)
    if not os.path.isfile(p): continue
    for m in re.finditer(r'from "(@/[^"]+|\.\.?/[^"]+)"',open(p).read()):
        r=resolve(m.group(1),os.path.dirname(f))
        if not r: continue
        if r in behind and r not in keep: need.add(r)
        q.append(r)
print("DEPLOY LIST (clone closure files that are box-behind and NOT in keep-set):")
for r in sorted(need): print("  ",r)
if not need: print("  (none — box already has everything else)")
PY
