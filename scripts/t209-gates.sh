#!/usr/bin/env bash
# TASK_209 gates: tsc + eslint (2 files) + hosting-files test + FULL suite.
set -u
cd /Users/mikeolab/spaceworker
OUT=/tmp/t209-gate
rm -f "$OUT".{tsc,lint,hosting,full}.txt

npx tsc --noEmit > "$OUT.tsc.txt" 2>&1
echo "TSC_EXIT=$?" >> "$OUT.tsc.txt"

npx eslint lib/hosting/rules.ts tests/hosting-files.test.ts > "$OUT.lint.txt" 2>&1
echo "LINT_EXIT=$?" >> "$OUT.lint.txt"

npx tsx --test tests/hosting-files.test.ts > "$OUT.hosting.txt" 2>&1
echo "HOSTING_EXIT=$?" >> "$OUT.hosting.txt"

npx tsx --test tests/*.test.ts > "$OUT.full.txt" 2>&1
echo "FULL_EXIT=$?" >> "$OUT.full.txt"

echo ALL_GATES_DONE
