-- PLAN_TASK_167 W4 — the admin-configured MINIMUM wallet top-up, checked by
-- POST /api/billing/topup before an order is ever opened.
--
-- ONE additive column with a default, so every existing AdminSetting row
-- instantly has a valid minimum and the route has no NULL branch to forget. The
-- default of 5 is the owner's suggested figure (plan §8.1) and is overridable in
-- Admin > Wallets & Prices without a deploy.
--
-- Deliberately written by hand, like the TASK_158 wallet migration, because this
-- needs a CHECK that Prisma cannot express: a non-positive minimum would make the
-- top-up route permanently unsatisfiable, and a check in a service function is a
-- check a migration or a psql session can walk straight around. A `0` minimum is
-- refused too — "no minimum" is not the same as "free", and silently reading one
-- as the other is how an admin ends up approving $0.01 orders by the hundred.
-- The route re-checks the same rule; this is what makes it true in the data.
--
-- NOTE the unit mismatch that is deliberate and must stay deliberate: this is
-- DOLLARS, while the wallet's own arithmetic (`WalletLedgerEntry.amountCents`,
-- `User.balanceCents`) is CENTS. The conversion happens once, in the top-up
-- route, and the only thing that crosses that boundary is a rounded integer.

ALTER TABLE "AdminSetting" ADD COLUMN "walletTopupMinUsd" DOUBLE PRECISION NOT NULL DEFAULT 5;

ALTER TABLE "AdminSetting"
  ADD CONSTRAINT "AdminSetting_walletTopupMinUsd_positive" CHECK ("walletTopupMinUsd" > 0);
