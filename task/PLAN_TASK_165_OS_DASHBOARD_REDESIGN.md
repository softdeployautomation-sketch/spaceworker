# PLAN — OS dashboard redesign: modal, wallpaper, sidebar, Wallet chip, top-up (2026-10-05)

Scope written after verifying the repo at `cb780cd`. Every claim below cites `file:line` and was
checked by the scoping agent, not inherited from a previous handoff.

## 0. Corrections to earlier handoffs (read before using ANY old plan)

**C1 — `Mailboxes` is NOT an unreachable page. Never add it to `NAV_ITEMS`.**
`app/dashboard/mailboxes/page.tsx:11` is `redirect("/dashboard/campaigns?tab=mailboxes")`.
Mailboxes live inside Campaigns as a tab, which is where the owner wants them. The same is true of
the other three routes that look orphaned:

| Route | Reality |
|---|---|
| `/dashboard/mailboxes` | `redirect("/dashboard/campaigns?tab=mailboxes")` — `mailboxes/page.tsx:11` |
| `/dashboard/browser-profiles` | `redirect("/dashboard/browser?tab=profiles")` — `browser-profiles/page.tsx:6` |
| `/dashboard/licenses` | `redirect("/dashboard/settings#licenses")` — `licenses/page.tsx:48` |
| `/dashboard/advanced-search` | `redirect("/dashboard/extract?template=advanced-search")` |

**There is no orphaned-page defect.** `TASK_161_DASHBOARD_OS.md` §2 D1 says to add Mailboxes to
`NAV_ITEMS`; **that sentence is wrong and must be corrected in the doc.** Adding it would create a
second entry for a tab that already exists inside Campaigns.

**C2 — the overview's dead filter line is the real defect.**
`app/dashboard/page.tsx:26-37` filters `useNavItems()` through a hardcoded allow-list that includes
`i.href === "/dashboard/mailboxes"`. **That condition can never be true**, because no nav item has
that href. The allow-list therefore looks maintained while silently dropping every newly added app —
which is exactly why Billing existed but appeared nowhere. **Delete the filter; do not patch it.**

**C3 — `TASK_161` §4 rule 6 ("the target user id in D4 comes from the admin session") is wrong.**
`lib/admin-auth.ts` shows the admin session is a shared passcode whose subject is the literal
string `"admin"`. There is no admin user id to forward. D4 (already shipped, `5d3b893b`) resolves
`userEmail` server-side with the gate before `request.json()`.

## 1. What the owner asked for (2026-10-05)

1. A **modal layer on top** of the overview showing balance and other status — a real dashboard feel.
2. **Wallpaper in the middle.**
3. A **small side nav**, visible **only on the overview dashboard**.
4. **Remove the overview cards** — every app is already reachable from the dock below.
5. **Take Billing out of the dock** and put it **in the top bar beside the date**, labelled **Wallet**.
6. **On the billing page: no "Add funds", no top-up flow where the user pays a wallet address and an
   admin approves.** See §3 for the verified answer to that question.

## 2. Current verified state (what exists to build on)

- **Desktop nav is a bottom dock**: `components/dock.tsx:19` — `fixed bottom-4 left-1/2`, `md:flex`,
  icon-only 44px tiles with truncated 9px labels (`:51`, `:71`). It splits `items.slice(0, -1)` as
  primary and the last item as settings (`:13-14`).
- **`DashboardNav` already supports `variant="sidebar"`** (`components/dashboard-nav.tsx:98-116`,
  a `flex-col` list) but **nothing renders it**; the only call site is `shell.tsx:59` with
  `variant="mobile"`. The sidebar markup therefore already exists and is styled — this is a wiring
  job, not a from-scratch build.
- **Top bar is `components/menu-bar.tsx`** — the place the Wallet chip goes.
- **Balance UI exists**: `components/wallet-balance.tsx`, already rendered at the top of
  `app/dashboard/billing/page.tsx:87, 99, 108`.
- **`GET /api/wallet` is shipped** (`231ae31`), rate-limited before the session check, identity only
  from `getCurrentUser()`. `getWallet()` is **server-only** — the client must fetch the route.

## 3. ⚠ ANSWER: is the "user pays a wallet address, admin approves, user gets credited" flow implemented?

**No. Not for the wallet. It exists only for product *tiers*, and it never touches the wallet.**

Verified, precisely:

- **The building blocks all exist in `lib/wallet.ts`** — `creditTopup` (`:431`),
  `creditApprovedPayment` (`:487`), `adminAdjustBalance` (`:567`), `debitPurchase` (`:456`),
  `canAfford` (`:473`), plus `WalletLedgerEntry` and `User.balanceCents` (`prisma/schema.prisma:131`,
  `:944`).
- **No production route calls any of them.** `grep -rn` for those five functions across `app/`,
  `lib/` and `tests/` returns hits **only inside `lib/wallet.ts` itself and `tests/wallet.test.ts`.**
  They are unit-tested and unwired.
- **What actually exists is a TIER purchase flow**: `POST /api/billing/submit` creates a
  `Payment` with `status: "pending"` (`app/api/billing/submit/route.ts:133-142`) for manual admin
  review. That is a **subscription/product upgrade**, not a wallet top-up, and it does **not** call
  `creditApprovedPayment` — so approving a payment does **not** credit a balance.
- **There is no `/api/wallet/grant`, `/api/billing/topup` or `/api/wallet/spend` route.**
  `POST /api/wallet` returns 405 — only GET is mounted.
- **`/dashboard/billing` has no "Add funds" CTA today** — it renders the balance card plus the tier
  `UpgradeFlow`. So there is nothing to remove; the "add funds" flow was never built.

**Consequence:** the owner's request in §1.6 is to **not build** that flow. That is consistent with
the money-adjacent rules and keeps W4 (`POST /api/billing/topup`) out of scope for now. **Money
reaches the wallet today only via admin action, and that admin route does not exist yet either —
it is `PLAN_TASK_158` §7 W3, still unbuilt.** Until W3 ships, the balance a user sees is always
`$0.00` in production. **That is the single most important thing the owner should know**, and it is
why the Wallet chip in the top bar will read `$0.00` on first release. Say so plainly rather than
shipping a chip that looks broken.

## 4. Phase plan (each phase independently shippable + revertible)

### P1 — Menu-bar Wallet chip (smallest, unblocks the rest)
Remove `{ href: "/dashboard/billing", label: "Billing", icon: CreditCard }` from `NAV_ITEMS`
(`dashboard-nav.tsx:67`) and render a **Wallet chip in `components/menu-bar.tsx`** beside the date,
reading `GET /api/wallet` via the existing pattern in `components/wallet-balance.tsx`, linking to
`/dashboard/billing`.
**Why the entry must be deleted, not hidden:** `NAV_ITEMS` is the single source of truth for the
dock, the mobile row and (after P2) the sidebar. A hidden-but-present entry reappears in the dock.
**`BUILD_ALLOWED_HREFS` needs no change** — `/dashboard/billing` is not in the extractor set, so it
was never in the EXE and removing it cannot regress that (verify, do not assume).
Keep `/dashboard/billing` reachable by URL; the chip is the entry point.
⚠ **Check `proxy.ts` first:** a `license_only` session is restricted to `/dashboard/licenses`, so a
chip linking to `/dashboard/billing` may 403 for those users. Decide and test, do not ship blind.

### P2 — Side nav on the overview ONLY
Render `DashboardNav variant="sidebar"` in the overview layout — **not** in `shell.tsx`, or it
appears on every page and contradicts the request.
Delete the dead hardcoded filter in `app/dashboard/page.tsx:26-37` (C2) so the overview tracks the nav.
**Overview cards are removed** per §1.4, so the sidebar becomes the overview's app launcher.
Must be `hidden md:flex` so it does not fight the dock on mobile.

### P3 — Modal + wallpaper
A centred modal layer over the overview carrying status (balance first), with the wallpaper behind
it. **D5 WALLPAPER IS PAUSED by the owner — do NOT build per-user wallpaper upload.** The wallpaper
here is a **static bundled asset**, not a user preference: no upload, no per-user storage, no
migration. Keep it a plain asset so pausing D5 stays true.
**D6 3D centrepiece is BLOCKED on licence verification** (`TASK_161` §2 D6.3). A `<SpaceScene />`
shell with **no asset** is fine; **never ship a licence-unverified clip.** Report it as a BLOCKER.

### P4 — Money (deferred, NOT part of this redesign)
`PLAN_TASK_158` W3 (`POST /api/admin/wallet/grant`) is the only way a balance becomes non-zero, and
it does not exist. It is **money-adjacent and must not be bundled into a UI redesign commit.**
Keep the redesign honest with a `$0.00` chip and a clear empty state.

## 5. Hard rules

1. **One concern per commit.** The chip, the sidebar, and the modal are three commits. Do not ship
   money code inside a UI commit (P4).
2. **`getWallet()` is server-only.** The client fetches `GET /api/wallet`. Integer cents end to
   end; `formatCents` for display.
3. **Build-target narrowing must not regress.** After P1/P2, confirm the Extractor EXE still shows
   only Overview/Extract/Settings.
4. **Never `git stash`, never `git add -A`.** `TASK_133_RMM_ENGINE_BRINGUP.md` is the owner's
   untracked stash work — leave it. Use a throwaway worktree for baselines.
5. **`CI=true npm run build`**, always. Never edit `.env`.
6. **Support widget stays bottom-left** — `AgentWidget` owns bottom-right; two widgets in one corner
   make the lower one unclickable.
7. **Gate before every commit**: `npx tsc --noEmit`, `npm run test:wallet` (29),
   `npm run test:support` (40), `npm run test:hosting` (334), touched-file ESLint,
   `CI=true npm run build`. **No CI runs these.**
8. **Commit, push, deploy are three steps.** Only `gh workflow run deploy.yml --ref main` deploys,
   and you must check the **job list** — a green run can have SKIPPED the deploy job.

## 6. Open questions I deliberately did NOT guess

1. **Which wallpaper/3D asset, and under what licence** — needs a human in a browser.
2. **What "and others" belong in the modal** beyond balance? Candidates exist (AI usage today via
   `getUsedAiTodayHundredthsCent`, devices online, agent state) but the set is the owner's call.
3. **Does the sidebar collapse on medium widths?** Unknown; a breakpoint must be chosen.
4. **Should the Wallet chip be visible to a `license_only` session?** `proxy.ts` restricts those
   sessions to `/dashboard/licenses`. **Verify before shipping P1.**