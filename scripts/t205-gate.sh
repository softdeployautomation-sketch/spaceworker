#!/usr/bin/env bash
# TASK_205 mid-implementation gate: tsc on the touched lib/route files only.
cd /Users/mikeolab/spaceworker
echo "=== tsc --noEmit (full) ==="
npx tsc --noEmit 2>&1 | head -40
echo "TSC_EXIT_PIPE_DONE"
