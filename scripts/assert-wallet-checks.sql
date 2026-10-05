\echo '--- A. negative postpaid limit (want REFUSED) ---'
UPDATE "User" SET "postpaidLimitCents" = -1;

\echo '--- B. ledger row for a nonexistent user (want REFUSED) ---'
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents")
VALUES ('a1','ghost-user','grant',1,1);

\echo '--- C. ExeLicense with NEITHER provenance (want REFUSED) ---'
UPDATE "ExeLicense" SET "paymentId" = NULL;

\echo '--- D. ExeLicense with BOTH provenances (want REFUSED) ---'
UPDATE "ExeLicense" SET "walletEntryId" = 'ok1' WHERE "paymentId" IS NOT NULL;

\echo '--- E. one payment crediting two wallets (want REFUSED) ---'
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents","paymentId")
SELECT 'dup1', u."id", 'grant', 1, 1, (SELECT p."id" FROM "Payment" p LIMIT 1)
FROM "User" u LIMIT 1;
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents","paymentId")
SELECT 'dup2', u."id", 'grant', 1, 1, (SELECT p."id" FROM "Payment" p LIMIT 1)
FROM "User" u LIMIT 1;

\echo '--- E2. the same idempotencyKey twice (want REFUSED) ---'
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents","idempotencyKey")
SELECT 'idem1', u."id", 'grant', 1, 1, 'the-same-key' FROM "User" u LIMIT 1;
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents","idempotencyKey")
SELECT 'idem2', u."id", 'grant', 1, 1, 'the-same-key' FROM "User" u LIMIT 1;

\echo '--- F. positive control: a VALID ledger row (want ALLOWED) ---'
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents")
SELECT 'ok1', id, 'grant', 500, 500 FROM "User" LIMIT 1;

\echo '--- G. positive control: a SECOND row with NULL paymentId (want ALLOWED) ---'
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents")
SELECT 'ok2', id, 'grant', 500, 1000 FROM "User" LIMIT 1;

\echo '--- H. deleting a user who has ONLY a ledger row (want REFUSED by the WALLET fk) ---'
-- Picks a user with a ledger row and no other inbound FK, so the refusal can only
-- come from WalletLedgerEntry_userId_fkey. Without that filter this test passes for
-- the wrong reason: deleting ANY real user trips ActivityRollup_userId_fkey first
-- and the wallet constraint is never actually exercised.
INSERT INTO "WalletLedgerEntry" (id,"userId","kind","amountCents","balanceAfterCents")
SELECT 'ok3', u."id", 'grant', 1, 1
FROM "User" u
WHERE NOT EXISTS (SELECT 1 FROM "ActivityRollup" a WHERE a."userId" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."userId" = u."id")
LIMIT 1;
DELETE FROM "User"
WHERE id = (SELECT "userId" FROM "WalletLedgerEntry" WHERE id = 'ok3');

\echo '--- I. final ledger state (want: ok1, ok2, ok3 -- and NO dup1/dup2/idem1/idem2) ---'
SELECT id, "kind", "amountCents", "balanceAfterCents", "paymentId", "idempotencyKey"
FROM "WalletLedgerEntry" ORDER BY id;