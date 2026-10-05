-- Proves ON DELETE RESTRICT on the wallet's user FK (migration.sql:56).
--
-- A real production user cannot be used for this: every one of them is referenced
-- by other tables (ActivityRollup, VerificationCode, Payment, ...), so deleting one
-- is refused by THOSE FKs first and the wallet constraint is never actually
-- exercised -- the test would pass for entirely the wrong reason. A synthetic user
-- has no other inbound FK, so the only thing that can refuse the delete is
-- WalletLedgerEntry_userId_fkey.

-- A brand-new user with no other inbound references.
INSERT INTO "User" (id, email, "passwordHash", "createdAt")
VALUES ('dryrun-synth-user', 'dryrun@example.invalid', 'x', now())
ON CONFLICT (id) DO NOTHING;

-- The ledger row that must block the delete.
INSERT INTO "WalletLedgerEntry" (id, "userId", "kind", "amountCents", "balanceAfterCents")
VALUES ('ok-synth', 'dryrun-synth-user', 'grant', 100, 100);

\echo '--- H. delete the synthetic user (want REFUSED by WalletLedgerEntry_userId_fkey) ---'
DELETE FROM "User" WHERE id = 'dryrun-synth-user';

\echo '--- H2. the synthetic user must still exist afterwards ---'
SELECT count(*) AS still_there FROM "User" WHERE id = 'dryrun-synth-user';

\echo '--- H3. and its ledger row must still exist (nothing cascaded away) ---'
SELECT count(*) AS ledger_rows FROM "WalletLedgerEntry" WHERE id = 'ok-synth';