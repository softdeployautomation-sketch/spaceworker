-- TASK_139 — self-serve DKIM for mail sent through SpaceWorker's own relay.
--
-- The relay (127.0.0.1:587 + OpenDKIM) removed the dependency on a customer's
-- own SMTP server for ACCEPTING mail. It cannot remove the dependency on the
-- From domain's DNS for AUTHENTICATING it: DKIM requires the customer to
-- publish the public half of the key we sign with, which is a one-time DNS
-- edit — the same step Resend/SendGrid/Mailgun all require. This table stores
-- the keypair, the exact record to publish, and whether the published value
-- actually matches the key we sign with.
--
-- "status" is DNS state only; "installedOnRelay" is the relay side. Kept
-- separate on purpose so a DNS lapse never hides a key that is still installed,
-- and a missing key never looks like a mere DNS problem.
CREATE TABLE "SendingDomain" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "selector" TEXT NOT NULL DEFAULT 'sw',
    "publicKeyTxt" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "privateKeyIv" TEXT NOT NULL,
    "privateKeyTag" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "installedOnRelay" BOOLEAN NOT NULL DEFAULT false,
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendingDomain_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SendingDomain_userId_domain_key" ON "SendingDomain"("userId", "domain");

CREATE INDEX "SendingDomain_domain_idx" ON "SendingDomain"("domain");

ALTER TABLE "SendingDomain"
    ADD CONSTRAINT "SendingDomain_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
