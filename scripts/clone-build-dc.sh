#!/usr/bin/env bash
set -u
# Build the CORRECT merged device-console.tsx:
#   base = origin/main (full clone UI, no movedAt)
#   + port the 2-line TASK_206 movedAt threading (type field + onboardingView call)
# Result must have clone-browsers=2 AND movedAt=2, no conflict markers.
SRC=/tmp/dc-theirs.tsx
OUT=/tmp/dc-final.tsx
python3 - "$SRC" "$OUT" <<'PY'
import sys
src,out=sys.argv[1],sys.argv[2]
s=open(src).read()

# 1) type block: insert movedAt field between stayOnDoneAt and releasedAt
t_old="    stayOnDoneAt: string | null;\n    releasedAt: string | null;"
t_new="    stayOnDoneAt: string | null;\n    movedAt: string | null;\n    releasedAt: string | null;"
assert s.count(t_old)==1, f"type anchor count={s.count(t_old)} (expected 1)"
s=s.replace(t_old,t_new)

# 2) onboardingView call: insert movedAt: row.movedAt between stayOnDoneAt and releasedAt
c_old="      stayOnDoneAt: row.stayOnDoneAt,\n      releasedAt: row.releasedAt,"
c_new="      stayOnDoneAt: row.stayOnDoneAt,\n      movedAt: row.movedAt,\n      releasedAt: row.releasedAt,"
assert s.count(c_old)==1, f"call anchor count={s.count(c_old)} (expected 1)"
s=s.replace(c_old,c_new)

open(out,"w").write(s)
print("written",out)
print("clone-browsers:",s.count("clone-browsers"))
print("movedAt:",s.count("movedAt"))
print("conflict markers:",s.count("<<<<<<<")+s.count(">>>>>>>"))
PY
echo "=== sanity: grep movedAt + clone in output ==="
grep -n 'movedAt' "$OUT"
grep -c 'clone-browsers' "$OUT"
