# PROMPT — NEXT FEATURE AGENT (OS dashboard: Wallet chip + overview-only side nav)

## 0. Your task in one line
Ship **P1 and P2** of `PLAN_TASK_165_OS_DASHBOARD_REDESIGN.md`: move Billing out of the dock into a
**Wallet chip in the top bar beside the date**, and add a **small side nav to the overview only**,
**removing the overview cards**. Two separate commits.

## 1. MANDATORY reading, before any command
  /Users/mikeolab/spaceworker/HOW_WE_MOVE_FAST.md
  /Users/mikeolab/spaceworker/PLAN_TASK_165_OS_DASHBOARD_REDESIGN.md   ← your scope, read §0 first
  /Users/mikeolab/spaceworker/SENIOR_HANDOFF.md
  /Users/mikeolab/spaceworker/PROMPT_NEXT_VERIFICATION_AGENT.md  §1 — the rules are BINDING
Full rule list: no multi-line `git commit -m` (use `-F<file>`); never print a secret; never edit
`.env`; never `npm run build` on the VPS; **never `git stash`**; never claim a check you did not see
pass. **Use `CI=true npm run build`** — `lib/env.ts` throws only when `NODE_ENV=production` AND
`CI` is unset, and the local `.env` holds a `local_dev_…` placeholder.

**State:** `main`, HEAD `cb780cd`, 0 ahead / 0 behind. `git status --short` shows exactly one
untracked file, `TASK_133_RMM_ENGINE_BRINGUP.md` — that is the owner's pre-existing stash work.
**Never `git add -A`, never stash, never delete it.** `git add` only the paths you touch.

## 2. ⚠ The owner's correction — read before you touch the nav

**Do NOT add `Mailboxes` to `NAV_ITEMS`.** An earlier handoff claimed it was unreachable; that was
wrong and the owner corrected it. `app/dashboard/mailboxes/page.tsx:11` is
`redirect("/dashboard/campaigns?tab=mailboxes")` — mailboxes are a **tab inside Campaigns**, which is
where the owner wants them. Same for `/dashboard/browser-profiles` → `/dashboard/browser?tab=profiles`
and `/dashboard/licenses` → `/dashboard/settings#licenses`. **There is no orphaned-page defect.**

`TASK_161_DASHBOARD_OS.md` §2 D1 contains that wrong instruction. **Correct the doc when you edit
that area — fix the doc, not the nav.**

**The real defect is one line above it.** `app/dashboard/page.tsx:26-37` filters `useNavItems()`
through a hardcoded allow-list containing `i.href === "/dashboard/mailboxes"` — a condition that can
**never be true**. The filter looks maintained while silently dropping every new app, which is why
Billing existed but appeared nowhere. **Delete the filter; do not patch it.**

## 3. P1 — Wallet chip in the top bar (commit 1)

Remove `{ href: "/dashboard/billing", label: "Billing", icon: CreditCard }` from `NAV_ITEMS`
(`components/dashboard-nav.tsx:67`) and add a **Wallet chip to `components/menu-bar.tsx`**, beside the
date, linking to `/dashboard/billing`.

* **Delete the entry — do not hide it.** `NAV_ITEMS` is the single source of truth for the dock, the
  mobile row and (after P2) the sidebar. A hidden-but-present entry reappears in the dock.
* **Read the balance over `GET /api/wallet`**, reusing the pattern already in
  `components/wallet-balance.tsx`. **`getWallet()` is server-only — never import it client-side.**
  Integer cents end to end; format with `formatCents`.
* `BUILD_ALLOWED_HREFS` (`dashboard-nav.tsx:75`) needs **no** change — `/dashboard/billing` was never
  in the extractor set. **Verify that, don't assume it.**
* ⚠ **Check `proxy.ts` first.** A `license_only` session is restricted to `/dashboard/licenses`, so a
  chip pointing at `/dashboard/billing` may 403 for those users. Decide deliberately and test it.
* ⚠ **The chip will read `$0.00` for every real user.** `PLAN_TASK_165` §3 proves no production route
  calls `creditTopup`/`creditApprovedPayment`/`adminAdjustBalance` — the wallet cannot be funded
  until `PLAN_TASK_158` W3 ships. **Render that honestly** (a clear empty/low-balance state), and
  **say so in your report.** Do not fake a balance and do not build a top-up flow to paper over it.

## 4. P2 — Side nav on the overview only (commit 2)

Render `DashboardNav variant="sidebar"` **on the overview only** — in the overview's own layout, NOT
in `components/shell.tsx`, or it shows on every page and contradicts the request.

* **Good news:** the sidebar variant already exists and is styled
  (`components/dashboard-nav.tsx:98-116`, a `flex-col` list). This is a **wiring job**, not a
  from-scratch build. Nothing renders it today; the only call site is `shell.tsx:59` with
  `variant="mobile"`.
* **Remove the overview cards** — the owner wants them gone because every app is already reachable
  from the dock below.
* **Delete the dead filter** at `app/dashboard/page.tsx:26-37` (§2 above).
* `hidden md:flex` so it does not fight the dock on small screens.
* Removing the cards removes the overview's only use of `DESCRIPTIONS` (`app/dashboard/page.tsx:12-22`).
  Either delete it or keep it only if something still reads it — **do not leave dead data behind.**
* Desktop nav is a **bottom dock** (`components/dock.tsx:19`, `fixed bottom-4 left-1/2`, `md:flex`,
  icon-only tiles). The sidebar must not overlap it.

## 5. Gate before EACH commit (separately, not once at the end)
    npx tsc --noEmit
    npx eslint on the touched files only
    npm run test:wallet  (29) · npm run test:support (40) · npm run test:hosting (334)
    CI=true npm run build
**No CI runs these.** Re-run after commit 1 and again after commit 2.

Then, separately: `git add <specific paths>` → `git commit -F<file>` → `git log -1` to **confirm the
commit happened** → `git push origin main`. **Pushing does not deploy.** Leave deploying to the
verifier, or run `gh workflow run deploy.yml --ref main` and check the **job list** — a green run can
have SKIPPED the deploy job.

## 6. Out of scope — do NOT build these
* **P3 (modal + wallpaper)** is a separate task. **D5 wallpaper is PAUSED by the owner** — if you ever
  build it, it is a **static bundled asset**, never a per-user upload/preference/migration.
  **D6 3D is BLOCKED on licence verification** — a `<SpaceScene />` shell with no asset is fine,
  but **never ship a licence-unverified clip** (Pexels/Pixabay 403 automated fetches; Mixkit's terms
  are behind JS modals). Report it as a BLOCKER.
* **P4 / wallet W3 (admin grant)** — money-adjacent, and **must not be bundled into a UI commit.**
* **Support (D3/D4) is already shipped and live** (`5d3b893b`, run `37305909697`). Do not rebuild it,
  and do not move the support widget: it is **bottom-left** because `AgentWidget` owns bottom-right,
  and two widgets in one corner make the lower one unclickable.

## 7. Report back
1. Gate results table — every command, real output, pass/fail/**outstanding**.
2. **Whether the Wallet chip renders for a `license_only` session**, and what you decided.
3. Proof Billing left the dock and the EXE nav still shows only Overview/Extract/Settings.
4. What you did about `DESCRIPTIONS` and the dead filter.
5. Anything you could not verify, plainly. Do not assume.