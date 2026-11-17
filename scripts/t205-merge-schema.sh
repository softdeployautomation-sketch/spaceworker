#!/usr/bin/env bash
set -u
# Merge task-205's 3 new LinkRedirect columns INTO the box's current schema (which
# already has cyberlab's sourceDeviceId). Neither feature may clobber the other.
# Source of truth for the merge:
#   - box schema (has sourceDeviceId, no task-205 cols)  = base
#   - task-205 schema (has desktopTitle/desktopBody/mobileTarget, no sourceDeviceId) = donor
set -u
BOX=/tmp/box-schema.prisma      # current live schema (cyberlab-complete)
T205=/tmp/t205-schema.prisma    # task-205 schema
OUT=/tmp/merged-schema.prisma

python3 - "$BOX" "$T205" "$OUT" <<'PY'
import sys, re
box, t205, out = sys.argv[1], sys.argv[2], sys.argv[3]
box_s = open(box).read()
t205_s = open(t205).read()

def model_block(text, name):
    m = re.search(r'(model %s \{[^\n]*\n)(.*?)(\n\})' % re.escape(name), text, re.S)
    return m

# 1. Pull task-205's LinkRedirect block
m205 = model_block(t205_s, 'LinkRedirect')
assert m205, "LinkRedirect not found in task-205 schema"
t205_body = m205.group(2)

# 2. Extract the 3 task-205-only lines (desktopTitle/desktopBody/mobileTarget + their comments)
keep_lines = []
lines = t205_body.split('\n')
capture = False
for i, ln in enumerate(lines):
    if 'desktopTitle' in ln or 'desktopBody' in ln or 'mobileTarget' in ln:
        # include the preceding TASK_205 comment lines
        j = i - 1
        comment = []
        while j >= 0 and (lines[j].strip().startswith('//') or lines[j].strip()==''):
            if lines[j].strip().startswith('//'):
                comment.insert(0, lines[j])
            j -= 1
            if lines[j].strip() and not lines[j].strip().startswith('//'):
                break
        keep_lines.extend(comment)
        keep_lines.append(ln)
t205_fields = '\n'.join(keep_lines)
assert 'mobileTarget' in t205_fields and 'desktopTitle' in t205_fields, "failed to capture task-205 fields:\n"+t205_fields

# 3. Insert those lines into the BOX LinkRedirect block, right before its closing brace
mbox = model_block(box_s, 'LinkRedirect')
assert mbox, "LinkRedirect not found in box schema"
start, body, end = mbox.start(2), mbox.group(2), mbox.end(2)
new_body = body.rstrip('\n') + '\n\n' + t205_fields + '\n'
merged = box_s[:start] + new_body + box_s[end:]

open(out, 'w').write(merged)
print("MERGED written:", out)
print("--- verify all 4 columns present in merged LinkRedirect ---")
mm = model_block(merged, 'LinkRedirect').group(2)
for f in ['desktopTitle','desktopBody','mobileTarget','sourceDeviceId','target','desktopOnly']:
    print(f"  {f}: {'YES' if f in mm else 'NO <<<'}")
# also confirm sourceDeviceId still in LabTarget
lab = model_block(merged, 'LabTarget').group(2)
print(f"  LabTarget.sourceDeviceId: {'YES' if 'sourceDeviceId' in lab else 'NO <<<'}")
PY
