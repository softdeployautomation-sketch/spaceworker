-- Task 42 — multi-product store + EXE license issuance.
--
-- AdminSetting: one price per product sold on the store/landing page. The old
-- planPriceUsd column is RENAMED to webSubscriptionPriceUsd (same role, new
-- default 25 — the owner's decided launch price for the web subscription,
-- superseding the previous 9.99) plus the four EXE tier prices.
--
-- Payment.product: distinguishes WHICH product a payment bought from the
-- payment METHOD (kind). Defaulted so every pre-existing row (all of which have
-- only ever been web subscriptions) is correctly labelled.
--
-- ExeLicense: a license issued once per approved EXE payment.

-- AdminSetting — rename the singleton price + add the four EXE prices.
-- Postgres keeps the column's existing default across a rename, so we
-- explicitly restate the new default for webSubscriptionPriceUsd.
ALTER TABLE "AdminSetting" RENAME COLUMN "planPriceUsd" TO "webSubscriptionPriceUsd";
ALTER TABLE "AdminSetting" ALTER COLUMN "webSubscriptionPriceUsd" SET DEFAULT 25;
ALTER TABLE "AdminSetting" ADD COLUMN "extractorExePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 50;
ALTER TABLE "AdminSetting" ADD COLUMN "mailerExePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 50;
ALTER TABLE "AdminSetting" ADD COLUMN "combinedExePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 70;
ALTER TABLE "AdminSetting" ADD COLUMN "automationExePriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 100;

-- Payment — which product the payment bought (not the payment method).
ALTER TABLE "Payment" ADD COLUMN "product" TEXT NOT NULL DEFAULT 'web_subscription';

-- ExeLicense — one row per approved EXE payment.
CREATE TABLE "ExeLicense" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "licenseKey" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExeLicense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExeLicense_paymentId_key" ON "ExeLicense"("paymentId");
CREATE UNIQUE INDEX "ExeLicense_licenseKey_key" ON "ExeLicense"("licenseKey");
CREATE INDEX "ExeLicense_userId_idx" ON "ExeLicense"("userId");

-- AddForeignKey
ALTER TABLE "ExeLicense" ADD CONSTRAINT "ExeLicense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExeLicense" ADD CONSTRAINT "ExeLicense_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;