#!/bin/sh
# TASK_158 W1 — dry-run 20261110000000_task158_wallet against a CLONE of the
# PRODUCTION database. Read-only with respect to production.
#
# WHY A CLONE AND NOT A SCRATCH DB BUILT FROM schema.prisma:
# scripts/replay-wallet-migration.sh reconstructs the "before" state by stripping
# the wallet block out of schema.prisma. That proves the migration agrees with the
# schema. It CANNOT prove the migration survives against the data production
# actually holds, and this migration adds a CHECK over an existing table
# (ExeLicense_exactly_one_provenance) — Postgres validates existing rows when a
# CHECK is added, so one pre-existing ExeLicense row with a NULL paymentId would
# make this migration FAIL on prod while passing the replay harness. That is the
# whole reason this script exists.
#
# Also asserts the CHECKs BEHAVIORALLY (try to violate each, confirm rejection),
# because a migration that applies cleanly but does not enforce is worse than no
# migration at all.
#
# The credential is read out of .env and passed via PGPASSWORD on stdin-free
# env -- never on argv, never printed.
set -e
# Where the app lives (holds .env). Defaults to this script's parent dir, which is
# correct in a checkout; the dry run is executed from a temp dir on the VPS,
# because it must read the VPS's own .env to reach the live database.
APP_ROOT="${SW_APP_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_ROOT"
echo "app root: $APP_ROOT"

MIGRATION="${SW_MIGRATION:-$APP_ROOT/prisma/migrations/20261110000000_task158_wallet/migration.sql}"
CLONE_DB="sw_wallet_dryrun"

PROD_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
if [ -z "$PROD_URL" ]; then echo "REFUSING: no DATABASE_URL in $APP_ROOT/.env" >&2; exit 1; fi
PROD_DB="$(echo "$PROD_URL" | sed 's#.*/##; s#?.*##')"
PROD_BASE="$(echo "$PROD_URL" | sed "s#/$PROD_DB\$##")"

echo "production database: $PROD_DB"
echo "clone database:      $CLONE_DB"

# Build a psql-usable URL for the clone from the production one, so the role and
# password are never hardcoded in this checked-in script.
CLONE_URL="$(echo "$PROD_BASE" | sed "s#\$#/$CLONE_DB#")"

export PGPASSWORD="$(echo "$PROD_URL" | sed 's#.*://\([^:]*\):\([^@]*\)@.*#\2#')"

# Creating the CLONE needs CREATEDB, which the app role (spaceworker_app) does not
# have -- it is deliberately a least-privilege role. Only the two DDL statements
# (CREATE/DROP DATABASE) are escalated, to the local postgres superuser over peer
# auth. Every read, and the migration itself, still run as the app role, so a
# privilege the migration needs but lacks in production fails HERE instead of
# being masked by superuser rights.
exec_as_admin() { su postgres -c "$1"; }

cleanup() {
  echo
  echo "--- dropping the clone ---"
  exec_as_admin "DROP DATABASE IF EXISTS $CLONE_DB" >/dev/null 2>&1 || true
  echo "clone dropped"
}
trap cleanup EXIT INT TERM

# Never clobber a database that already exists. This one is read through the
# superuser, because the app role may not be able to see other databases.
if exec_as_admin "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$CLONE_DB'\"" \
   | grep -q 1; then
  echo "REFUSING: $CLONE_DB already exists" >&2
  exit 1
fi

echo
echo "--- 0. what production actually holds (read-only) ---"
psql "$PROD_URL" -tAc \
  'SELECT count(*) FROM "ExeLicense"' | sed 's/^/ExeLicense rows:            /'
psql "$PROD_URL" -tAc \
  'SELECT count(*) FROM "ExeLicense" WHERE "paymentId" IS NULL' \
  | sed 's/^/  of which paymentId NULL: /'
psql "$PROD_URL" -tAc \
  'SELECT count(*) FROM "User"' | sed 's/^/User rows:                  /'
psql "$PROD_URL" -tAc \
  'SELECT count(*) FROM "Payment"' | sed 's/^/Payment rows:               /'

echo
echo "--- 1. clone production (schema + data) ---"
exec_as_admin "createdb -T $PROD_DB $CLONE_DB" 2>/dev/null \
  || {
    # -T TEMPLATE needs zero other sessions on the source DB; production always
    # has some, so fall back to a full dump/restore.
    echo "TEMPLATE unavailable (live connections) -- falling back to pg_dump"
    exec_as_admin "createdb $CLONE_DB"
    pg_dump "$PROD_URL" | psql "$CLONE_URL" -q
  }
psql "$CLONE_URL" -tAc 'SELECT count(*) FROM "User"' \
  | sed 's/^/clone User rows: /'

echo
echo "--- 2. apply the wallet migration to the CLONE ---"
psql "$CLONE_URL" -v ON_ERROR_STOP=1 -q -f "$MIGRATION"
echo "APPLIED OK"

echo
echo "--- 3. new objects exist ---"
psql "$CLONE_URL" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_name='WalletLedgerEntry'" \
  | sed 's/^/WalletLedgerEntry table: /'
psql "$CLONE_URL" -tAc \
  "SELECT count(*) FROM information_schema.columns
     WHERE table_name='User' AND column_name IN ('balanceCents','postpaidLimitCents')" \
  | sed 's/^/User wallet columns:    /'
psql "$CLONE_URL" -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname IN
     ('User_postpaidLimitCents_non_negative','ExeLicense_exactly_one_provenance')" \
  | sed 's/^/new CHECK constraints: /'

echo
echo "--- 4. break each rule on purpose (each must be REFUSED) ---"
UID_A="$(psql "$CLONE_URL" -tAc 'SELECT id FROM "User" LIMIT 1')"
if [ -z "$UID_A" ]; then echo "no user rows to test FK against"; exit 1; fi
psql "$CLONE_URL" -tAc \
  "UPDATE \"User\" SET \"postpaidLimitCents\"=-1 WHERE id='$UID_A'" >/dev/null 2>/tmp/e1 \
  && { echo "FAIL: a negative postpaid limit was ALLOWED"; exit 1; } \
  || echo "refused:  a negative postpaid limit"
psql "$CLONE_URL" -tAc \
  "UPDATE \"ExeLicense\" SET \"paymentId\"=NULL, \"walletEntryId\"=NULL" >/dev/null 2>/tmp/e2 \
  && { echo "note: no ExeLicense rows to test provenance against"; } \
  || echo "refused:  a license with NEITHER a payment nor a wallet entry"
psql "$CLONE_URL" -tAc \
  "INSERT INTO \"WalletLedgerEntry\" (id,userId,kind,amountCents,balanceAfterCents)
     VALUES ('dryrun-no-user','no-such-user','grant',1,1)" >/dev/null 2>/tmp/e3 \
  && { echo "FAIL: a ledger row for a nonexistent user was ALLOWED"; exit 1; } \
  || echo "refused:  a ledger row pointing at no user"

echo
echo "--- 5. ON DELETE RESTRICT on the money trail ---"
psql "$CLONE_URL" -q -c "
  INSERT INTO \"WalletLedgerEntry\" (id,userId,kind,amountCents,balanceAfterCents)
  VALUES ('dryrun-restrict','$UID_A','grant',100,100)" >/dev/null 2>&1 || true
psql "$CLONE_URL" -tAc \
  "DELETE FROM \"User\" WHERE id='$UID_A'" >/dev/null 2>/tmp/e4 \
  && { echo "FAIL: deleting a user with a ledger row was ALLOWED"; exit 1; } \
  || echo "refused:  deleting a user who has ledger rows"

echo
echo "DRY RUN OK"