# PLAN — TASK 158: Wallet / Balance-First Billing

**Status:** scoped, ready to build. Nothing implemented.
**Predecessor:** Task 157 (platform domains) — live, `32a280a`, deploy `37176597402`.
**Successor:** Task 156 (Cyber Lab C2+).

---

## 1. The request (owner, 2026-10-03)

> "now i want the payment flow for spaceworker not to be mandatory for subscription,
> i want users to be able to add balance to there account first, then they can decide to
> make use of that balance for subscription or other things."

This is a **change of billing model**, not a new payment method. Today every
SpaceWorker payment is a *purchase of one specific product*: the payment row
carries `product` (`web_subscription` | `extractor_exe` | `mailer_exe` |
`combined_exe` | `automation_exe`) and approving it grants exactly that one
thing (`lib/license-service.ts` → `handleApprovedPayment`). The buyer must
decide what they want at checkout time and cannot change their mind.

The ask inverts that: **the wallet is the product of the payment; everything
else is bought *from* the wallet.** A user tops up once, then spends that
balance whenever, on whatever, across many purchases — or leaves a balance
sitting there untouched.

Reuse target is Vantra, which already works this way in production. Do not
invent a second model.

---

## 2. Live reconnaissance (2026-10-03, this session)

### 2.1 Vantra — the proven reference (read, not assumed)

| Concern | Where | How it works |
|---|---|---|
| Balance column | `vantra/prisma/schema.prisma` | `User.walletBalanceCents Int @default(0)` — plain Int, incremented/decremented |
| Top-up intent | `Payment` model | `kind` = `"topup"`, plus `amountUsd Int` (cents), `walletAddress`, `priceAtOrderUsd`, `expectedAmountCrypto`, `actualAmountUsd`, `confirmations`, `verificationStatus` (`pending`\|`pending_review`\|`auto_approved`\|`manually_approved`\|`auto_rejected`) |
| Credit | `vantra/app/api/admin/payments/[paymentId]/confirm/route.ts:70-86` | `$transaction`: `updateMany({ where: { id, verificationStatus: "pending_review" } })` → `count === 0` means bail; else `user.update({ data: { walletBalanceCents: { increment: cents } } })`. That `count` guard is what makes a double-click or two admin sessions credit **once**. |
| Debit | same file `:116-123` | `updateMany({ where: { id, walletBalanceCents: { gte: priceCents } }, data: { walletBalanceCents: { decrement: priceCents } } })` → `count === 0` means a concurrent spend won. Race-safe: no read-then-write. |
| Never auto-grant | `vantra/app/api/billing/manual/submit/route.ts:35-42` | On-chain verification only ever produces `pending_review`. Even a *confirmed* transaction never credits. An admin decides. |
| Amount ceiling | confirm route `:18-23` | Admin may edit the credited amount, clamped `$0.01 … $5,000`. |
| Admin wallet UI | `vantra/app/api/admin/wallets/route.ts`, `vantra/lib/wallet-settings.ts` | Inspect/adjust any user's balance + price knobs |

**What Vantra does NOT have:** a ledger table. `walletBalanceCents` is mutated
directly, so there is no per-transaction history, "where did my $20 go?" cannot
be answered from the DB, and there is no `idempotencyKey`. §4 adds both — this
is the one place we should *improve on* Vantra rather than copy it.

### 2.2 SpaceWorker — what exists today

Already present:
- `AdminSetting.btcWallet` / `.usdtWallet` (TRC20) / `.usdtErc20Wallet` — the
  three receiving addresses, same as Vantra. **No new addresses needed.**
- `app/api/billing/{checkout,status,submit}/route.ts` — the crypto top-up flow.
- `app/api/admin/payments/[id]/{approve,reject,retry-license}/route.ts`.
- `lib/license-service.ts` — `handleApprovedPayment(id)`, the single
  "payment approved → grant its product" handler.
- `lib/premium.ts` — `PREMIUM_TIER = 5`, `PREMIUM_DAYS_PER_CHARGE = 30`,
  `isPremiumWithReversion()`, `applyPremiumReversion()`.
- `lib/entitlements.ts` — entitlement key registry, already the right shape for
  future wallet-purchasable features.
- `app/dashboard/billing/` and `app/dashboard/settings/` pages.

The gaps:
- **`User` has no `balanceCents` column at all.**
- `Payment.amountUsd` is **`Float`** (Vantra uses Int cents). Float money plus a
  wallet is a rounding bug waiting to happen — see §3 D3.
- No ledger model, no `idempotencyKey`, no audit trail.
---

## 3. Decisions

**D1 — The wallet is money-in; everything else is bought *from* it.**
`web_subscription` becomes one purchasable item among many, not the thing a
payment *is*.

**D2 — `User.balanceCents Int @default(0)`.** Int, not BigInt: matches Vantra in
production, caps around $21M, keeps arithmetic readable. Integer cents, never
Float, ever.

**D3 — Leave the existing `Payment.amountUsd Float` alone.** Widening it to
cents would ripple through checkout, the verification poller, the admin payment
list, the EXE license maths and every historical row — a migration with a real
blast radius and **zero user benefit**. Instead add integer columns for
wallet-relevant amounts. Rule: **all new wallet maths uses integer cents;
`amountUsd` Float is never read by wallet code.**

**D4 — Top-ups reuse `product = "wallet_topup"`** rather than adding a column,
so `/api/billing/*` and the admin payments list keep working unchanged. Add
`Payment.creditedCents Int?` (what was *actually* credited — an admin may credit
less than requested) and `Payment.adminNote String?` (why).

**D5 — Copy Vantra's guarded-update pattern verbatim in shape:** a conditional
`updateMany` whose `count === 0` means "someone else already did this." This is
the load-bearing invariant of the entire feature.

**D6 — An immutable ledger is the history; `User.balanceCents` is the cached
total.** Every balance change writes a `WalletLedgerEntry` **in the same
transaction** as the balance mutation, with `balanceAfterCents` stored on the
row. `User.balanceCents` is never hand-edited — only through `lib/wallet.ts`.
This is what Vantra lacks.

**D7 — EXE licenses are IN SCOPE (owner, 2026-10-03).** Revised from the original
"keep EXE on the direct flow" call. The owner's reasoning: *"users can top their
wallet to purchase the exe licenses so our web app becomes a place they can come
to fix and replace their license as well."* So a wallet purchase must be able to
mint an `ExeLicense`, and the wallet becomes the repair/replace surface for a
license, not just a billing surface.

**⚠️ The blocker this creates — `ExeLicense.paymentId` is `@unique` and REQUIRED.**
```prisma
model ExeLicense {
  paymentId String  @unique
  payment   Payment @relation(fields: [paymentId], references: [id])
  ...
}
```
A wallet purchase has **no payment row**, so the current schema cannot express
"this license came from balance". D9 resolves this.

**D8 — Premium activation from the wallet reuses `lib/premium.ts` verbatim** —
`PREMIUM_DAYS_PER_CHARGE = 30`, the same `applyPremiumReversion` semantics. The
only new thing is where the money comes from.

**D9 — Wallet-purchased EXE licenses get their own nullable `ledgerEntryId`.**
Make `ExeLicense.paymentId` **nullable** and add a nullable
`walletEntryId String? @unique` + FK. Every license then has exactly one of the
two provenance columns, and the DB can enforce that invariant.

Why not "create a synthetic zero-value Payment row instead"? It would keep
`paymentId` non-null and avoid a migration — but it **fakes money that never
moved**, corrupting revenue reporting and every payment-status lookup. A wallet
purchase genuinely has no payment; the schema should say so. This is why D7 costs
a migration even though it looks like one line of logic.

**⚠️ `issueExeLicense()` (`lib/license-service.ts:130`) currently hardcodes
`paymentId`.** It must be refactored to take a provenance union — either a
payment or a ledger entry — without disturbing its existing idempotency check
(`findUnique({ where: { paymentId } })` → return if exists, line ~104), which is
the double-mint guard and must keep working for BOTH paths. A wallet purchase
that can mint two keys for one debit is a real money bug.

---

## 4. Schema

All additive. Nothing is renamed, dropped or retyped, so every existing row
keeps its meaning and no backfill is required.

```prisma
model User {
  // ...existing fields untouched...
  balanceCents  Int  @default(0)   // TASK_158 D2. Money IN, cached total.
  walletEntries WalletLedgerEntry[]
  walletGrants  WalletLedgerEntry[] @relation("WalletAdminActor")
}

// TASK_158 — immutable. One row per balance movement, append-only, never
// updated or deleted. balanceAfterCents is the running total as of that row,
// which makes "my balance was $40 on the 3rd" answerable from the DB alone
// (Vantra cannot answer this).
model WalletLedgerEntry {
  id        String @id @default(cuid())
  userId    String
  user      User   @relation(fields: [userId], references: [id])
  // Signed: positive = money in, negative = money out. Keeping the sign in the
  // row means the history reads as a statement without a `direction` column.
  amountCents       Int
  balanceAfterCents Int
  // "topup"        — admin credited an approved crypto payment
  // "purchase"     — user spent balance on a product/entitlement
  // "refund"       — a purchase was reversed
  // "admin_grant"  — manual credit, no payment involved
  // "admin_adjust" — manual correction (can be negative)
  kind      String
  // Free-text label for the UI, e.g. "Premium — 30 days" or "Hosting link pack".
  note      String?
  // Set when kind is a purchase: what was bought.
  refType   String?
  refId     String?
  // Null unless an admin did it. The audit metadata that makes a manual grant
  // explainable months later.
  adminId   String?
  admin     User?  @relation("WalletAdminActor", fields: [adminId], references: [id])
  // D6 idempotency: a replayed request (double-click, retry, cron overlap) must
  // not move money twice. NULL for ordinary user-initiated spends.
  idempotencyKey String? @unique
  createdAt DateTime @default(now())

  @@index([userId, createdAt])
}

model Payment {
  // ...existing fields untouched...
  // D4 — amount the admin ACTUALLY credited, when this row is a top-up.
  creditedCents Int?
  adminNote     String?
}

model ExeLicense {
  // D9 — provenance is now EITHER a payment OR a wallet ledger entry, never
  // both and never neither. paymentId becomes NULLABLE so a wallet purchase can
  // mint a license; ledgerEntryId is the mirror for the wallet path.
  //
  // ⚠️ Both nullables means the DB alone no longer forces "exactly one". Add a
  // CHECK constraint in the migration SQL and verify it in the drift check:
  //   (paymentId IS NOT NULL) <> (walletEntryId IS NOT NULL)
  // Payment keeps RESTRICT semantics; do NOT add ON DELETE CASCADE (trap 23's
  // ON DELETE lesson — a cascade here silently destroys license audit rows).
  paymentId   String?
  payment     Payment? @relation(fields: [paymentId], references: [id])
  walletEntryId String? @unique
  walletEntry WalletLedgerEntry? @relation(fields: [walletEntryId], references: [id])
  // ...rest of ExeLicense unchanged...
}

// back-relation on WalletLedgerEntry
model WalletLedgerEntry {
  // ...
  issuedLicense ExeLicense?
}
```

**Why `idempotencyKey` is `@unique` and nullable:** Postgres allows many NULLs
under a unique index, so ordinary spends (no key) never collide, while a keyed
admin grant or retried webhook is deduplicated by the database itself.

---

## 5. `lib/wallet.ts` — the only writer

Every balance mutation in the app goes through this module. Nothing else calls
`prisma.user.update({ data: { balanceCents ... } })`.

```ts
// lib/wallet.ts
export async function creditWallet(tx, opts: {
  userId: string;
  amountCents: number;      // must be > 0
  kind: "topup" | "admin_grant" | "admin_adjust" | "refund";
  note?: string;
  refType?: string; refId?: string;
  adminId?: string;
  idempotencyKey?: string;
}): Promise<{ ok: true; balanceAfterCents: number } | { ok: false; code: string; message: string }>

export async function debitWallet(tx, opts: {
  userId: string;
  amountCents: number;      // must be > 0
  kind: "purchase";
  note?: string;
  refType?: string; refId?: string;
  idempotencyKey?: string;
}): Promise<{ ok: true; balanceAfterCents: number } | { ok: false; code: string; message: string }>
```

Both run inside a caller-supplied Prisma transaction. `debitWallet`'s
insufficient-funds path returns `code: "insufficient_funds"` and the route
turns that into HTTP 402 — **the check is the `updateMany` guard, never a
prior `findUnique`** (that is Vantra's race-safe shape, confirm route
`:116-123`).

`balanceAfterCents` is computed by the same `updateMany` that moves the money,
so the ledger row and the cached total can never disagree.

---

## 6. API contracts

### 6.1 `GET /api/wallet` (new, authenticated)
```json
{ "balanceCents": 4250, "entries": [ { "id":"…","amountCents":-1500,
  "balanceAfterCents":4250,"kind":"purchase","note":"Premium — 30 days",
  "createdAt":"…" } ] }
```
Read-only. Never expose another user's entries.

### 6.2 `POST /api/wallet/spend` (new, authenticated)
Spends on the **web subscription only** in W4 (D7 keeps EXE out).
```json
// in:  { "product": "web_subscription" }
// out: 200 { "ok":true,"balanceCents":2750,"premiumExpiresAt":"2026-11-02T…" }
//      402 { "error":"Insufficient balance.","code":"insufficient_funds" }
//      409 { "error":"Already premium.","code":"already_active" }
```
Must be **atomic across the debit and the tier bump** — one `$transaction`, so a
crash can never take money without granting premium, or grant it for free.

### 6.3 `POST /api/billing/topup` (new, authenticated)
Creates a `Payment` with `product: "wallet_topup"`, `amountUsd` (display only,
from the request, validated against the admin-configured minimum), and the
address from `AdminSetting`. Returns the amount to send and the address.
**No credit happens here** — this only opens the order (Vantra's
`pending_review` discipline, submit route `:35-42`).

### 6.4 `POST /api/admin/payments/[id]/approve` (MODIFIED)
Branch on `product`:
- `"wallet_topup"` → guarded credit into the wallet (Vantra confirm route
  `:70-86`), writing a `topup` ledger row and setting `creditedCents` /
  `adminNote`. Does **not** call `handleApprovedPayment`.
- anything else → today's behaviour, unchanged.

### 6.5 `POST /api/admin/wallet/grant` (new, admin-only)
`{ userId, amountCents, note, idempotencyKey }` → `admin_grant` ledger row.
Rejects a duplicate `idempotencyKey` with 409 instead of double-crediting.
Negative amounts route to `admin_adjust`.

---
## 7. Build order

Each phase is independently deployable and leaves the app working.

| Phase | Scope | Gate |
|---|---|---|
| **W1** | Migration (`balanceCents`, `WalletLedgerEntry`, `Payment.creditedCents/adminNote`, **and D9: `ExeLicense.paymentId` nullable + `walletEntryId`** + CHECK constraint) + `lib/wallet.ts` + unit tests. **No routes, no UI.** | Migration replays on a fresh DB (trap 23) AND §6b drift check is clean |
| **W2** | `GET /api/wallet` + balance display on the dashboard and `/dashboard/billing`. | Existing tests still green |
| **W3** | `POST /api/admin/wallet/grant` + admin panel section | Grant is audited and idempotent |
| **W4** | `POST /api/billing/topup` + the modified approve route | A top-up credits the wallet, not a tier |
| **W5** | `POST /api/wallet/spend` for `web_subscription` + "Activate with balance" on `/dashboard/billing` | Debit and tier bump are atomic |
| **W6** | **EXE from the wallet (D7/D9)** — widen `/api/wallet/spend` to EXE products; refactor `issueExeLicense()` for dual provenance; a "Replace / re-issue my license" surface in `/dashboard/licenses` | One debit ⇒ exactly ONE key; existing payment path unchanged |

W1 first, always. W5 without W4 is pointless, and W4 without W1 is impossible.

---

## 8. Security invariants

1. **No float money in new code.** Integer cents end to end (D3).
2. **The ledger is append-only.** No `update`/`delete` on `WalletLedgerEntry`, ever.
3. **`User.balanceCents` has exactly one writer** — `lib/wallet.ts`.
4. **Guard, don't check-then-act.** Every mutation is a conditional `updateMany`
   whose `count === 0` is the failure signal (D5).
5. **Debit and grant are single-transaction.** Debit + entitlement/premium, or
   credit + payment status, commit together or not at all.
6. **A top-up never auto-credits.** On-chain confirmation is not payment
   (Vantra submit route `:35-42`).
7. **Every admin credit carries `adminId`.** An unattributed balance change is a
   support incident.
8. **Admin routes check the admin session first**, before parsing the body —
   follow `requireAdminSession` / `getAdminSession` as the repo already does.

---

## 9. Acceptance tests (new file `tests/wallet.test.ts`)

1. Two concurrent `creditWallet` calls with the same `idempotencyKey` produce
   **one** ledger entry and one balance increase.
2. Two concurrent `debitWallet` calls of the full balance produce **one** success
   and one `insufficient_funds`; the balance never goes negative.
3. Debiting more than the balance yields 402 and writes **no** ledger row.
4. `balanceAfterCents` on each ledger row equals the running sum of all prior
   rows plus the current amount.
5. Every ledger row's final balance matches `User.balanceCents` at commit time.
6. A failed premium grant rolls the debit back (balance unchanged, no ledger row).
7. Approving a `wallet_topup` payment increases the balance and does **not**
   change `tier` or `premiumExpiresAt`.
8. Approving a `web_subscription` payment behaves exactly as it does today
   (regression guard on D7).
9. A non-admin calling `/api/admin/wallet/grant` gets 403.
10. `GET /api/wallet` for user A never returns user B's entries.
11. A duplicate `txHash` still cannot create a second top-up row (existing
    `txHash @unique` still holds with the new columns).

### 9.1 EXE-from-wallet tests (W6) — `tests/wallet-exe.test.ts`

12. A wallet purchase of an EXE product creates an `ExeLicense` with
    `walletEntryId` set and `paymentId` **NULL**, and a claim token, exactly as
    the payment path does.
13. **The double-mint guard holds for the wallet path**: one debit ⇒ exactly ONE
    `ExeLicense` row. Replaying the same `idempotencyKey` returns the existing
    license and does not mint a second key (this is the D9 warning — a
    second key for one debit is real money lost).
14. **Regression: the payment path is untouched.** `handleApprovedPayment` on an
    approved EXE payment still creates a license with `paymentId` set and
    `walletEntryId` NULL, still emits its email + claim link, and its existing
    `retry-license` admin route still recovers a `flagged` EXE payment.
15. The CHECK constraint holds: no insert with both provenance columns NULL, and
    none with both set. Assert by attempting the bad insert and expecting failure.
16. Insufficient balance for an EXE purchase ⇒ 402, **no license, no ledger row**,
    and no email sent to the user.
17. A wallet-bought license appears in `/dashboard/licenses`
    (`licenses-section.tsx:26`) and its key is retrievable there.
18. `app/api/exe-license/payment-status/route.ts:59` (`findUnique({ where:
    { paymentId } })`) is **not** broken by the nullable column — assert its
    behaviour when `paymentId` is NULL. This is the likeliest place a nullable
    FK causes a runtime type error or a silently-wrong "not found".

---

## 10. Open questions for the owner

- **O1 — RESOLVED (owner, 2026-10-03): YES, EXE licenses are purchasable from the
  wallet** — see D7/D9 and phase W6. The wallet is also the place a customer
  comes to *fix and replace* a license. Remaining sub-question, now O5 below:
  what a re-issue costs.
- **O2** — Refund policy: when an admin rejects a previously credited top-up,
  should the balance go negative (allowed, recoverable) or should the admin
  issue an explicit `admin_adjust`? Plan currently allows negative.
- **O3** — Minimum top-up amount and whether there is a maximum per order.
- **O4** — Should a user be able to spend balance on hosting link packs /
  storage overages (the `hostingPremiumMaxLinks` family in `AdminSetting`), or
  is balance-for-premium-only for now? The `lib/entitlements.ts` +
  `lib/hosting/rules.ts` cap machinery already makes this a clean extension.
- **O5** — What does a **re-issued / replacement EXE license** cost? Full price
  again, or free when the original was already paid for (defect replacement)? This
  is a policy choice, and it decides whether W6's "fix and replace" flow needs a
  refund/debit path at all. **Ask before building W6's replace flow.**
- **O6** — When a wallet-bought EXE license is replaced, does the OLD license
  row get superseded (revoked / `boundMachineId` cleared) or do both stay valid?
  `ExeLicenseTransfer` + `lib/exe-license-bind.ts:60` already reason about
  machine binding, so this is a real decision, not a detail.
