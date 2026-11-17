#!/usr/bin/env bash
set -euo pipefail
cd /Users/mikeolab/spaceworker
git fetch origin -q
echo "=== status before ==="
git status --short | head
git branch --show-current
echo "=== newest migrations on origin/main (migration floor) ==="
git ls-tree --name-only origin/main prisma/migrations/ | sort | tail -3
git checkout -b agent/task-205-link-routing-wording origin/main
echo "=== now on ==="
git branch --show-current
git rev-parse --short HEAD
