#!/usr/bin/env bash
# TASK_207 gate — run from the repo root. One gate script per the playbook:
# no compound inline commands (the terminal mangles them).
set -u
cd /Users/mikeolab/spaceworker

echo "=== 1. tsc --noEmit ==="
npx tsc --noEmit > /tmp/t207-gate-tsc.txt 2>&1
echo "tsc exit=$? (see /tmp/t207-gate-tsc.txt)"
grep -E "error TS" /tmp/t207-gate-tsc.txt | head -15

echo "=== 2. eslint (changed files) ==="
npx eslint components/device-console.tsx lib/device-tools.ts lib/device-onboarding.ts tests/console-mesh-scope.test.ts > /tmp/t207-gate-lint.txt 2>&1
echo "eslint exit=$?"
cat /tmp/t207-gate-lint.txt | head -30

echo "=== 3. FULL test suite (no pre-existing errors tolerated) ==="
npx tsx --test tests/*.test.ts > /tmp/t207-gate-test.txt 2>&1
echo "tests exit=$?"
grep -E "^# (tests|pass|fail|skipped)" /tmp/t207-gate-test.txt

echo "=== GATE DONE ==="