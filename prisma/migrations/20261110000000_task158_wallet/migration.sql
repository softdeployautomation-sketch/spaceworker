-- TASK_158 W1 — the WALLET: a cached balance on User plus the append-only
-- WalletLedgerEntry that explains it.
--
-- There is NO existing code that spends money, so nothing is backfilled:
-- `balanceCents` defaults to 0 for every current user, which is exactly what they
-- all have. A migration that invented a starting balance would be inventing money.
--
-- The two columns are deliberately NOT NULL DEFAULT 0 rather than nullable. A
-- nullable balance has two spellings of zero — NULL and 0 — and every future
-- comparison then has to remember which is which, which is precisely the class of
-- bug this feature exists to remove.
--
-- The CHECK constraints are the point of writing this migration by hand instead of
-- letting `prisma migrate dev` generate it: Prisma has no way to express them, and
-- a rule that lives only in a service function is a rule that a future migration,
-- a psql session, or a well-meaning script can walk straight around.
--   * a negative postpaid LIMIT is meaningless (it would mean "must stay in
--     credit"), and admitting one would make every debit arithmetic ambiguous.
--   * a ledger row must belong to exactly one user, which is already implied by
--     NOT NULL but is also what the ExeLicense provenance CHECK depends on.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "balanceCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "postpaidLimitCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "User"
  ADD CONSTRAINT "User_postpaidLimitCents_non_negative" CHECK ("postpaidLimitCents" >= 0);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "note" TEXT,
    "paymentId" TEXT,
    "adminId" TEXT,
    "idempotencyKey" TEXT,
    "postpaidLimitAfterCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletLedgerEntry_paymentId_key" ON "WalletLedgerEntry"("paymentId");
CREATE UNIQUE INDEX "WalletLedgerEntry_idempotencyKey_key" ON "WalletLedgerEntry"("idempotencyKey");
CREATE INDEX "WalletLedgerEntry_userId_createdAt_idx" ON "WalletLedgerEntry"("userId", "createdAt");

-- AddForeignKey
-- ON DELETE RESTRICT on both user FKs, deliberately. A wallet ledger that
-- cascades away with the user it describes would delete the only record of money
-- that was ever moved; a delete that is genuinely wanted has to be an explicit,
-- audited decision rather than a side effect of removing an account.
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "creditedCents" INTEGER,
ADD COLUMN "adminNote" TEXT;

-- AlterTable
-- PROVENANCE. A license is paid for either by a Payment or by a wallet entry, and
-- never by both, never by neither. The `@unique` on paymentId is deliberately
-- KEPT: Postgres treats NULLs as distinct under a unique index, so any number of
-- wallet-funded licenses can carry a NULL paymentId while two licenses still
-- cannot claim the same payment.
ALTER TABLE "ExeLicense" ALTER COLUMN "paymentId" DROP NOT NULL;
ALTER TABLE "ExeLicense" ADD COLUMN "walletEntryId" TEXT;

ALTER TABLE "ExeLicense"
  ADD CONSTRAINT "ExeLicense_exactly_one_provenance"
  CHECK (("paymentId" IS NOT NULL) <> ("walletEntryId" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "ExeLicense_walletEntryId_key" ON "ExeLicense"("walletEntryId");

-- AddForeignKey
ALTER TABLE "ExeLicense" ADD CONSTRAINT "ExeLicense_walletEntryId_fkey" FOREIGN KEY ("walletEntryId") REFERENCES "WalletLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;