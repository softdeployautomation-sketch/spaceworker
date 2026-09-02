# SpaceWorker Task 5 — Billing + Admin Panel

**Depends on**: Task 1 (auth/scaffold). Independent of Tasks 2/3/4 otherwise — this is almost entirely porting already-proven, already-live code from Vantra, not new design work.

## What to port from Vantra, near-verbatim

Read these files in `/Users/mikeolab/vantra` and adapt them (rename cookie/issuer strings, point at this product's own DB) rather than redesigning anything — this exact system has been live-tested with real on-chain transactions:

- **`lib/crypto-verify.ts`** — BTC (blockchain.info, two-call confirmation pattern) and USDT-TRC20 (Tronscan, the `typeof data.confirmed !== "boolean"` not-found check) verification. Copy this file close to as-is.
- **`prisma/schema.prisma`**'s `Payment`, `PaymentVerificationAttempt`, `AdminSetting` (wallet address fields) models — port the shape exactly, just adjust `Payment.amountUsd`/`kind` semantics to whatever this product's actual pricing tiers end up being (that's a pricing decision for later, not a schema change).
- **`lib/premium.ts`**'s `extendPremium` pattern — adapt to however SpaceWorker's own plan/tier gating ends up working (this may end up being simpler than Vantra's premium/free split, since Task 3 already introduced `User.tier` for queue priority — decide whether billing directly sets `tier`, or whether there's a separate `plan` field; don't invent a third parallel concept without checking with the user first).
- **`app/api/billing/checkout/route.ts`** and **`app/api/billing/manual/submit/route.ts`** — the ±5% tolerance band, auto-approve vs. flag-for-review split, `txHash` uniqueness constraint. Port the logic, adapt the amounts.
- **The admin panel pattern** (`app/admin101/(protected)/*`, `lib/admin-auth.ts` — already ported in Task 1) — build out a **Users** tab (list, with `tier` editing per Task 3), a **Payments** tab (the flagged-payment review queue, approve/reject), and a **Wallets** tab (BTC/USDT-TRC20 address config).

## What NOT to port

`lib/billing.ts`'s OpenNode integration — its own code comments in Vantra self-document that the webhook HMAC verification was never confirmed against a real delivery. Go manual-crypto-only from the start here; don't inherit that unverified path.

## Customer-facing billing UI

A simple "Upgrade"/"Add funds" flow (exact pricing/tiers TBD with the user — don't invent numbers, ask if the plan doesn't already specify them) showing the configured wallet address + expected crypto amount, a transaction-hash submission form, and status feedback (auto-approved / flagged-pending-review / rejected) — this can be a close copy of Vantra's `components/billing-card.tsx` + `components/billing-crypto-panel.tsx`.

## Verification

1. Full manual crypto payment flow with a real small on-chain transaction (BTC or USDT-TRC20), same discipline as Vantra's own verification: confirm auto-approval within tolerance, confirm a wrong-address submission auto-rejects, confirm an out-of-tolerance amount flags for review and the admin approve/reject actions both work.
2. Confirm the admin panel fails closed if its passcode env var is unset (inherited from Task 1, just re-confirm it still holds once Payments/Wallets/Users tabs are added).
3. Confirm a `txHash` can't be reused across two different payments (DB-level unique constraint, not just an application check).
