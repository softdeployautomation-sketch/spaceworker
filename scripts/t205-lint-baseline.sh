#!/usr/bin/env bash
# Prove the eslint error at hosting-panel is pre-existing (present on HEAD, untouched by TASK_205).
cd /Users/mikeolab/spaceworker
git show HEAD:components/hosting-panel.tsx > /tmp/t205-baseline-panel.tsx 2>/dev/null
echo "=== baseline file lines: $(wc -l < /tmp/t205-baseline-panel.tsx) ==="
echo "=== does baseline contain the exact offending effect? ==="
grep -n 'void loadStatus();' /tmp/t205-baseline-panel.tsx
echo "=== my diff hunks (none should be the loadStatus effect) ==="
git diff -U0 components/hosting-panel.tsx | grep -E '^@@'
echo "=== DONE ==="
