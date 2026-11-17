#!/usr/bin/env bash
# TASK_205 A1 — validate the migration matches the schema and that prisma is happy.
set -euo pipefail
cd /Users/mikeolab/spaceworker
echo '=== prisma validate ==='
npx prisma validate
echo '=== migrate diff (should be EMPTY = schema and migrations agree) ==='
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "${SHADOW_DB_URL:-}" 2>&1 | head -40 || true
echo '=== DONE ==='
