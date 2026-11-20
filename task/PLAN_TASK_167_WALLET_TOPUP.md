# PLAN_TASK_167 — Wallet top-up: W3 (admin grant) + W4 (user pays, admin credits)

> **This is a MONEY plan.** `PLAN_TASK_165` §5 rule 1 and `PLAN_TASK_158` §8 both forbid
> bundling money code into a UI commit, and this is that commit. Nothing here ships in the
> same commit as anything cosmetic. Read `PLAN_TASK_158_WALLET_BALANCE.md` §4–§9 first; this
> document only covers what is new since it was written (2026-10-03).
>
> Scope: **W3 and W4 only.** W5 (`/api/wallet/spend`) and W6 (EXE-from-wallet) stay OUT —
a wallet with no way to spend it is a smaller problem than a debit path shipping without a
credit path to feed it.

---

## 1. The owner's question, and the verified answer (2026-10-05)

Owner: *"hope we have the add funds in wallet that leads to the payment path, and not only
for subscription… which is the wallet plan."*

**Answer: no. There is no Add-funds path into the wallet, for the subscription or for
anything else.** Verified this session, not inferred:

- `creditTopup()` (`lib/wallet.ts:431`) has **zero production callers**. `grep -rn
  creditTopup` hits only `lib/wallet.ts` itself and `tests/wallet.test.ts`.
- `adminAdjustBalance()` (`:567`) — same, and there is **no `app/api/admin/wallet`
  directory at all**.
- `creditApprovedPayment()` (`:487`) — no caller.

So the owner's instinct is right, and the honest current state is that **a user's balance
is `$0.00` in production and always will be until W3+W4 ship.** This is already documented
in `components/wallet-chip.tsx:28-33`, which renders an explicit "no funds yet" state
rather than a bare `$0.00` — that comment stays TRUE until W4 is live, at which point the
chip should link to the new top-up surface. Do not delete it before the feature exists; it
is the only thing telling a reader why the balance is empty.

### ⚠ Do not confuse two different "wallets"

The string **`"Wallet not configured"`** — which the owner hit locally — is **not** the
SpaceWorker wallet. It is `app/api/billing/checkout/route.ts:69` and
`app/api/billing/submit/route.ts:116`, raised when `AdminSetting.btcWallet` /
`usdtWallet` / `usdtErc20Wallet` are empty: the **crypto payout address you receive money
at**. It is set in the admin panel (`admin-panel.tsx:727-747`) and is configured in
production. Two unrelated subsystems both use the word "wallet"; do not let that word send
you to the wrong one.

---

## 2. What already exists (do not rebuild)

| Piece | Where | Note |
|---|---|---|
| `creditTopup` | `lib/wallet.ts:431` | unit-tested, **unwired** |
| `adminAdjustBalance` | `lib/wallet.ts:567` | unit-tested, **unwired** |
| `creditApprovedPayment` | `lib/wallet.ts:487` | unit-tested, **unwired** |
| CAS-guarded `move()` | `lib/wallet.ts:238` | the only writer of `User.balanceCents` |
| `WalletLedgerEntry` | schema | append-only, `adminId`/`adminNote` present |
| `Payment.creditedCents/adminNote` | schema | already migrated (W1) |
| `GET /api/wallet` | W2, `231ae31` | session-scoped read |
| Payment create + on-chain verify | `app/api/billing/submit` | tier purchase only |
| Vantra's proven credit route | `vantra/app/api/admin/payments/[paymentId]/confirm/route.ts:70-86` | the reference for the guarded credit |

**The ledger, the guards and the tests exist. This is wiring, not a new financial system.**

---

## 3. W3 — `POST /api/admin/wallet/grant` (admin-only)

Contract, from `PLAN_TASK_158` §6.5:
`{ userId, amountCents, note, idempotencyKey }` → an `admin_grant` ledger row.

Hard requirements, each traceable to `PLAN_TASK_158` §8:

1. **Check the admin session BEFORE parsing the body** (§8.8), using whatever
   `requireAdminSession` / `getAdminSession` the repo already does elsewhere in
   `app/api/admin/`. Do not invent a third auth helper.
2. **Every credit carries `adminId`** (§8.7). An unattributed balance change is a support
   incident — this is the whole point of the column.
3. **Duplicate `idempotencyKey` → 409**, never a second credit. `move()` already accepts
   an `idempotencyKey`; find out whether it enforces this itself before re-implementing
   it. If it does not, the guard is the conditional-`updateMany` pattern, not a
   check-then-act (§8.4).
4. **Negative amounts route to `admin_adjust`**, not `admin_grant` — two different ledger
   kinds with two different meanings in the UI.
5. **Integer cents.** No float touches money (§8.1).
6. Admin panel section: a user lookup + amount + note + submit, and the ledger row appears
   in the user's history afterwards.

## 4. W4 — `POST /api/billing/topup` + the modified approve route

Two steps, and **they must ship together** — a top-up that can be opened but never credited
is worse than no top-up, because a user will send real money to an address.

**4a. `POST /api/billing/topup`** (authenticated) — `PLAN_TASK_158` §6.3:
creates a `Payment` with `product: "wallet_topup"`, `amountUsd` **validated against the
admin-configured minimum** (a user must not be able to open a $0.01 order and, later, have
an admin top them up for it), and the address from `AdminSetting`. **It credits nothing.**
It only opens the order. The UI reuses the existing copy-address/submit-hash component
from `/dashboard/billing`; do not write a second one.

**4b. `POST /api/admin/payments/[id]/approve` (MODIFIED)** — branch on `product`:
- `"wallet_topup"` → guarded credit into the wallet (Vantra's `confirm` route `:70-86`),
  writing a `topup` ledger row and setting `creditedCents` + `adminNote`. It must **not**
  call `handleApprovedPayment` / grant a tier.
- anything else → **today's behaviour, byte-for-byte unchanged.** This branch is the risk:
  the existing subscription and EXE purchase flow depends on it, and the owner sells those
  products. Get this wrong and a paying customer gets a wallet balance instead of a
  licence.

## 5. Traps specific to this work

1. **Money code in a UI commit.** §5 rule 1 of `PLAN_TASK_165` and §7 of this plan. Three
   commits at most: W3 route+panel, W4 route+approve-branch, W4 UI. If you find yourself
   fixing a Tailwind class while `creditTopup` is in the diff, stop and split.
2. **The deploy is a separate manual job** — a push-triggered run reporting success may
   have SKIPPED it. Check the job list, never the run conclusion.
3. **Do not `git stash`.** Use a throwaway worktree for a lint baseline.
4. **`TASK_133_RMM_ENGINE_BRINGUP.md` is the owner's untracked work.** Never `git add -A`.
5. **Migration hygiene.** This work should need **no migration** — W1 already created
   `creditedCents`/`adminNote`/`adminId`. If you find yourself writing one, you have
   misread the schema; stop and re-read `PLAN_TASK_158` §4. If you genuinely need one, it
   is its own commit and must dry-run against a clone of production first.
6. **Test counts move.** `test:wallet` is **29** today; it will be higher. Report the real
   number, never the remembered one.
7. **Never a shell heredoc for multi-KB file content** — it corrupts the file through the
   terminal wrapper. Use your editor tool. And after every commit run `git log -1` to
   confirm it actually happened: on 2026-10-05 a mangled commit command left the work
   UNCOMMITTED while appearing to have run.

## 6. Explicitly OUT of scope

- **W5** (`POST /api/wallet/spend`, "Activate with balance") — a debit path. Separate
  concern, separate commit, and it must not ride along in W3/W4.
- **W6** (EXE-from-wallet, D7/D9) — dual-provenance `issueExeLicense()` refactor.
- Card/ACH rails. The existing checkout is BTC/USDT-TRC20/USDT-ERC20; keep it.
- Changing the tier purchase flow, EXCEPT the 4b branch guard above.

## 7. Acceptance

- [ ] W3: grant credits once; a replayed `idempotencyKey` 409s; the ledger row names the
      admin; a negative amount lands as `admin_adjust`.
- [ ] W3: non-admin → 401/403 **before** any body parsing.
- [ ] W4: top-up creates a pending payment and credits **nothing** on creation.
- [ ] W4: approving a `wallet_topup` credits the wallet, writes `creditedCents`, and
      grants **no** entitlement.
- [ ] W4: approving a `web_subscription` behaves **exactly** as before (regression test).
- [ ] W4: double-approving the same top-up cannot credit twice.
- [ ] Gates: `npx tsc --noEmit`, `npm run test:wallet`, `npm run test:support`,
      `npm run test:hosting`, ESLint on touched files, `CI=true npm run build`.
- [ ] Commits are separate, money-only, and each is pushed and deployed on its own.
- [ ] `components/wallet-chip.tsx` "no funds yet" copy updated **in the same commit** the
      top-up surface ships, not before.

## 8. Still open for the owner (do not guess)

1. **Minimum top-up amount** — §4a requires a configured minimum; no default is safe to
   invent. Suggest `$5` and wait for a yes.
2. **Who approves, and how fast.** Owner-only admin today. If a support agent ever needs
   it, that is a permissions change, not a route tweak.
3. **EXE licences are excluded from top-up** (D7) — confirm that is still the intent
   before W5 is scoped, not during W4.

**A top-up NEVER auto-credits** (§8.6). On-chain confirmation is not payment. Vantra's
discipline: even a *confirmed* transaction only produces `pending_review`; an admin
decides. Do not be tempted by the existing `verifyUsdtPayment` success path.

**Credit + payment status commit in ONE transaction** (§8.5). A crash must never leave a
payment marked approved with an uncredited wallet, or a credited wallet with a pending
payment the admin can approve again.