-- TASK_CYBERLAB — widen PremiumInvoice's two CLOSED CHECKs for the Cyber Lab
-- add-on (owner: an extension invoice, NOT a plan): `plan` gains 'cyberlab'
-- and `tier` gains the sentinel 6 that maps to it. Tier 6 is never a User.tier
-- value — every reader branches on `plan` first (settle grants the module
-- entitlement; invoice displays name the plan), so 6 can never bump a tier.
--
-- DROP + re-ADD (CHECKs are not ALTERable): every row written under the old
-- constraint satisfies the new one (both old values stay included), so no
-- existing row is invalidated and no data is touched — additive in effect,
-- matching the house "never change what exists" rule.

ALTER TABLE "PremiumInvoice" DROP CONSTRAINT "PremiumInvoice_plan_check";
ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_plan_check"
    CHECK ("plan" IN ('premium_plus', 'premium_xdevice', 'cyberlab'));

ALTER TABLE "PremiumInvoice" DROP CONSTRAINT "PremiumInvoice_tier_check";
ALTER TABLE "PremiumInvoice" ADD CONSTRAINT "PremiumInvoice_tier_check"
    CHECK ("tier" IN (3, 5, 6));
