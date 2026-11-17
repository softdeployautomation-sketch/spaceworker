#!/usr/bin/env bash
set -u
KEY=~/.ssh/tacticalrmm_vps
HOST=root@164.68.105.96
ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 "$HOST" 'cd /opt/spaceworker && echo "=== migrations dir count ===" && ls prisma/migrations/ 2>/dev/null | wc -l && echo "=== newest 3 migrations ===" && ls prisma/migrations/ 2>/dev/null | tail -3 && echo "=== _prisma_migrations table row count ===" && sudo -u postgres psql -d spaceworker -tAc "SELECT count(*) FROM _prisma_migrations;" 2>&1 && echo "=== LinkRedirect columns NOW (task-205 should be ABSENT) ===" && sudo -u postgres psql -d spaceworker -tAc "SELECT column_name FROM information_schema.columns WHERE table_name=chr(76)||chr(105)||chr(110)||chr(107)||chr(82)||chr(101)||chr(100)||chr(105)||chr(114)||chr(101)||chr(99)||chr(116) ORDER BY ordinal_position;" 2>&1 | tr "\n" " "; echo'
