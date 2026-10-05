#!/bin/sh
# Scratch replay harness for TASK_158 W1's migration. Never touches the dev DB.
#
# WHAT IT PROVES, and why each step is load-bearing:
#
#   1. The pre-wallet schema is pushed to a THROWAWAY database. Deriving it by
#      stripping the wallet block out of schema.prisma is what makes the replay
#      meaningful: the migration then has to work against the schema that actually
#      existed before it, including every table the wallet's FKs point at. The
#      earlier version of this script read /tmp/old-schema.prisma, which meant it
#      only ran on the machine that happened to have left that file behind — a
#      green run that a colleague could never reproduce.
#   2. The migration applies on top of it, by hand, with ON_ERROR_STOP.
#   3. `migrate diff` reports ZERO difference from schema.prisma. This is the step
#      that keeps the hand-written SQL and the schema from drifting apart, and it
#      is the only step that would have caught the ON DELETE mismatch earlier.
#   4. The database's own constraints are then VIOLATED ON PURPOSE. A migration
#      that silently fails to create a constraint still passes steps 1-3 — only
#      trying to break the rule proves the rule is there.
set -e
cd "$(dirname "$0")/.."
ROOT=$(pwd)

# Read the app's own credentials out of .env and repoint ONLY the database name.
# Hardcoding a different user here would need a GRANT dance for no benefit, and
# hardcoding a password in a script checked into the repo would be its own bug.
export DATABASE_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed 's#/spaceworker$#/sw_wallet_base#')"
SCRATCH_DB=$(echo "$DATABASE_URL" | sed 's#.*/##; s#?.*##')
echo "scratch database: $SCRATCH_DB"

OLD_SCHEMA="$ROOT/.wallet-replay-old-schema.prisma"

# Strip the wallet from the schema to reconstruct the "before" state. Kept in a
# dotted temp name inside the repo (not /tmp) so it resolves relative imports the
# same way the real schema does, and it is removed on every exit path.
trap 'rm -f "$OLD_SCHEMA"' EXIT INT TERM

awk '
  # Drop the model blocks this migration adds.
  /^model WalletLedgerEntry \{/ { skip = 1 }
  /^model PlatformAccount \{/    { skip = 1 }
  skip && /^\}/ { skip = 0; next }
  skip { next }
  # Drop every BACK-reference to a removed model as well. Leaving these behind is
  # the trap: Prisma fails validation on a relation whose other end no longer
  # exists, and the error names the model, not the dangling line.
  /WalletLedgerEntry\[\]/ { next }
  # The wallet scalars on User, and the ExeLicense provenance pair.
  /^  balanceCents +Int +@default\(0\)$/ { next }
  /^  postpaidLimitCents +Int +@default\(0\)$/ { next }
  /^  walletEntryId +String\? +@unique$/ { next }
  /^  walletEntry +WalletLedgerEntry\?/ { next }
  # Payment.creditedCents / Payment.adminNote, which this same migration adds. If
  # these stay, `db push` creates them and the migration fails on "already exists"
  # — which is the correct behaviour, and exactly why the replay is worth running:
  # it is the only place that notices the migration and the schema disagree about
  # what "before" means.
  /^  creditedCents +Int\?$/ { next }
  /^  adminNote +String\?$/ { next }
  { print }
' prisma/schema.prisma > "$OLD_SCHEMA"

echo '--- 0. the reconstructed PRE-wallet schema must be valid, or step 1 proves nothing ---'
# Set -e is deliberately NOT relied on here: `prisma validate` writes its diagnosis
# to stdout, so a non-zero exit alone would abort with no explanation of why.
if ! ./node_modules/.bin/prisma validate --schema "$OLD_SCHEMA" 2>&1 | tail -3; then
  echo "FAIL: the reconstructed pre-wallet schema is not valid"
  exit 1
fi

psql -v ON_ERROR_STOP=1 -q -d "$SCRATCH_DB" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null

echo '--- 1. push the PRE-wallet schema ---'
./node_modules/.bin/prisma db push --schema "$OLD_SCHEMA" --skip-generate --accept-data-loss 2>&1 | tail -2

echo '--- 2. apply the wallet migration ---'
psql -v ON_ERROR_STOP=1 -q -d "$SCRATCH_DB" -f prisma/migrations/20261110000000_task158_wallet/migration.sql
echo 'APPLIED OK'

echo '--- 3. drift: migrated database vs schema.prisma (exit 0 = none) ---'
set +e
./node_modules/.bin/prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --exit-code
DRIFT=$?
set -e
echo "drift exit=$DRIFT"

# Steps 1-3 all pass on a migration that silently FAILED to create a constraint:
# `migrate diff` compares the schema Prisma infers, and a missing CHECK or UNIQUE
# index is exactly the kind of thing it cannot see. So the rules are then broken
# ON PURPOSE. A rule that was never created lets the bad row through, and that is
# the only way to tell "the constraint exists" from "the constraint was supposed to
# exist".
if [ "$DRIFT" -ne 0 ]; then
  echo "FAIL: the migrated database does not match schema.prisma."
  exit 1
fi

Q() { psql -v ON_ERROR_STOP=1 -q -tA -d "$SCRATCH_DB" -c "$1"; }

# A rule that must be ENFORCED: if the statement succeeds, the constraint is missing.
expect_refused() {
  if out=$(Q "$2" 2>&1); then
    echo "FAIL: $1 was ALLOWED"
    exit 1
  fi
  echo "refused:  $1"
}

# A rule that must be PERMITTED, so an over-eager constraint is caught too.
expect_allowed() {
  if ! out=$(Q "$2" 2>&1); then
    echo "FAIL: $1 was refused: $out"
    exit 1
  fi
  echo "allowed:  $1"
}

echo
echo '--- 4. break each rule on purpose ---'
Q "INSERT INTO \"User\"(id,email,\"passwordHash\") VALUES ('u1','a@b.c','x')" >/dev/null
Q "INSERT INTO \"Payment\"(id,\"userId\",kind,\"amountUsd\",\"toAddress\",status,\"createdAt\",\"updatedAt\") VALUES ('p1','u1','btc',10,'addr','approved',now(),now())" >/dev/null
Q "INSERT INTO \"WalletLedgerEntry\"(id,\"userId\",kind,\"amountCents\",\"balanceAfterCents\",\"paymentId\") VALUES ('w1','u1','topup',100,100,'p1')" >/dev/null

expect_refused "a negative postpaid limit" \
  "UPDATE \"User\" SET \"postpaidLimitCents\" = -1 WHERE id='u1'"

expect_refused "one payment crediting two wallets" \
  "INSERT INTO \"WalletLedgerEntry\"(id,\"userId\",kind,\"amountCents\",\"balanceAfterCents\",\"paymentId\") VALUES ('w2','u1','topup',100,200,'p1')"

expect_refused "a license with BOTH a payment and a wallet entry" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",\"paymentId\",\"walletEntryId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e1','u1','p1','w1','x','k1',now())"

expect_refused "a license with NEITHER" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e2','u1','x','k2',now())"

expect_refused "a ledger row pointing at no user" \
  "INSERT INTO \"WalletLedgerEntry\"(id,\"userId\",kind,\"amountCents\",\"balanceAfterCents\") VALUES ('w9','ghost','topup',100,100)"

echo
echo '--- 5. and the cases that must still WORK ---'

# Establish ONE valid payment-funded license. The refusals above prove nothing about
# paymentId uniqueness on their own: since every earlier license insert was rolled
# back, nothing yet holds 'p1', and a second one would trivially succeed.
expect_allowed "a payment-funded license" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",\"paymentId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e3','u1','p1','x','k3',now())"

expect_refused "one payment funding two licenses" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",\"paymentId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e3b','u1','p1','x','k3b',now())"

expect_allowed "a wallet-funded license (paymentId NULL)" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",\"walletEntryId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e4','u1','w1','x','k4',now())"

# The subtle one. `ExeLicense.paymentId` is UNIQUE and NULLABLE, and Postgres
# treats NULLs as equal for uniqueness purposes, so MANY wallet-funded licenses can
# coexist. If this ever fails, someone has replaced the unique index with a
# partial one or added a NOT NULL default — and wallet-funded purchases are then
# impossible for every existing customer.
#
# The second license needs a SECOND wallet entry: it is the NULL paymentId that is
# doing the work, and a row with no provenance at all is refused by the CHECK for a
# completely different reason, which would make this test pass for the wrong cause.
Q "INSERT INTO \"WalletLedgerEntry\"(id,\"userId\",kind,\"amountCents\",\"balanceAfterCents\") VALUES ('w2','u1','debit_purchase',-100,-100)" >/dev/null
expect_allowed "a SECOND wallet-funded license (NULLs do not collide in a UNIQUE index)" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",\"walletEntryId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e5','u1','w2','x','k5',now())"

expect_refused "one wallet entry funding two licenses" \
  "INSERT INTO \"ExeLicense\"(id,\"userId\",\"walletEntryId\",product,\"licenseKey\",\"issuedAt\") VALUES ('e6','u1','w1','x','k6',now())"

echo
echo '--- 6. ON DELETE RESTRICT is declared, not defaulted to SET NULL ---'
# Prisma's default for an OPTIONAL relation is SetNull, which would erase the
# provenance this whole feature exists to keep. Deleting the payment must therefore
# be refused, not quietly blank the license's paymentId.
if out=$(Q "DELETE FROM \"Payment\" WHERE id='p1'" 2>&1); then
  echo "FAIL: deleting a credited payment was ALLOWED (FK is not RESTRICT)"
  exit 1
fi
echo "refused:  deleting a payment that funded a ledger entry"

echo
echo "REPLAY OK"