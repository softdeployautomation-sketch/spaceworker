#!/usr/bin/env bash
set -u
cd /Users/mikeolab/spaceworker || exit 1
python3 - <<'PY'
import os, re
ROOT="/Users/mikeolab/spaceworker"
behind=set(l.strip() for l in open("/tmp/box_behind.txt") if l.strip())
files=[
 "lib/hosting/links.ts","lib/hosting/links-engine.ts","lib/hosting/workers.ts",
 "app/r/[token]/route.ts","components/hosting-panel.tsx",
 "app/api/hosting/links/[id]/route.ts","app/api/hosting/links/route.ts",
]
def resolve(imp, base):
    if imp.startswith("@/"):
        t=imp[2:]
    elif imp.startswith("."):
        t=os.path.normpath(os.path.join(base, imp))
    else:
        return None
    for e in ["",".ts",".tsx","/index.ts","/index.tsx"]:
        cand=t+e
        if os.path.isfile(os.path.join(ROOT,cand)):
            return cand
    return None
hits=set()
for f in files:
    p=os.path.join(ROOT,f)
    if not os.path.isfile(p):
        print("MISSING SOURCE:",f); continue
    base=os.path.dirname(f)
    for m in re.finditer(r'from "(@/[^"]+|\.\.?/[^"]+)"', open(p).read()):
        r=resolve(m.group(1), base)
        if r and r in behind:
            hits.add((r,f))
if hits:
    print("=== task-205 imports that are BEHIND on box (would break build) ===")
    for r,f in sorted(hits): print(f"  {r}  <- {f}")
else:
    print("=== CLEAN: no task-205 import is box-stale. Build safe. ===")
PY
