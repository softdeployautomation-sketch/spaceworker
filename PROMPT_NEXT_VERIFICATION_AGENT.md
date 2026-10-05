# PROMPT — NEXT VERIFICATION AGENT (starts from commit `892e209`)

> ## ★ WHAT CHANGED SINCE THE LAST HANDOFF — read this first
>
> **P1 + P2 are SHIPPED, COMMITTED, PUSHED and DEPLOYED.** Do not re-verify them as
> uncommitted work and do not re-commit them. Commits `c3a9d00` (P1 Wallet chip) and
> `29bfbbc` (P2 overview-only side nav) are live.
>
> **`892e209` adds three things, and it is the commit you must verify:**
> 1. **TASK_166 — unread notification on the support button** (the owner's bug report:
>    *"the message delivered into the user, but it didn't show like a notification on
>    the support button"*).
> 2. **P3 — the dashboard status row** (`GET /api/overview-stats`).
> 3. **Marketing: 5 pillars, Hosting + Cyber Lab presented as available.**
>
> **Your primary work item is `PLAN_TASK_167_WALLET_TOPUP.md` — wallet W3 + W4.** The
> owner asked mid-session whether Add-funds leads to a payment path. The verified answer
> is **NO** — see §3, and do not let the previous agent's optimism stand uncorrected.
>
> ### ⚠ The Cyber Lab switch — check this first, it is an owner action
> The marketing copy in `892e209` now presents **Cyber Lab as a live product** with no
> "coming soon" and no beta label, per the owner's explicit instruction. But
> `PLAN_TASK_164` §3 records `cyberlabEnabled = false` in production, and the lab panel
> still renders *"Not available yet"*. **The owner said he will flip the switch the same
> night.** Verify the actual production value of `cyberlabEnabled` and report it. If it is
> still `false`, the live site is making a claim its own product page contradicts — that
> is a finding for your report, not something to fix yourself.

---

## 1. MANDATORY reading, before any command
  /Users/mikeolab/spaceworker/HOW_WE_MOVE_FAST.md
  /Users/mikeolab/vantra/TASK_MANAGEMENT_PLAYBOOK.md
  /Users/mikeolab/spaceworker/SENIOR_HANDOFF.md
  /Users/mikeolab/spaceworker/PLAN_TASK_167_WALLET_TOPUP.md   <- YOUR WORK ITEM
  /Users/mikeolab/spaceworker/PLAN_TASK_158_WALLET_BALANCE.md <- §4 schema, §8 invariants, §9 tests
Then read the task doc named in the work item. Rules you must not break:

1. Never `git commit -m "..."` with multi-line text. Write the message to a file, use
   `git commit -F<file>`.
2. Never print, echo, log or paste a real secret. Cloudflare tokens are AES-256-GCM encrypted;
   only the last-4 hint is ever exposed.
3. Never modify `.env` or any environment variable to make something work. This has caused two
   production outages (2026-09-27).
4. Never `npm run build` on the VPS. The box has no `lib/` source tree and no `tsconfig.json`;
   only `.next` and `node_modules` are deployed. To inspect deployed code, grep `.next/server` for
   a marker string (playbook §6).
5. "Done" ≠ committed ≠ pushed ≠ deployed ≠ proven live. Prove each separately.
6. Never claim a check passed that you did not see pass. A command you aborted, timed out, or
## 2. Verified state as of handoff (2026-10-05, after `892e209`)

Branch `main`, HEAD **`892e209`**, pushed and deployed (run `37328850999`).

Recent history (newest first):
```
892e209 TASK_166 + P3: unread notification on the support button, and status row
29bfbbc feat(dashboard): overview-only side nav, overview cards removed (P2)
c3a9d00 feat(dashboard): Wallet chip in the top bar, Billing out of the dock (P1)
5d3b893 feat(support): customer widget, admin queue, admin-composed tickets, Billing nav
231ae31 feat(wallet): W2 — authenticated GET /api/wallet and a read-only balance card
```

**Gates for `892e209` — run by the implementing agent, NOT yet independently verified:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean, 0 errors |
| `npx eslint` on all 8 touched files | clean, 0 |
| `tests/support-tickets.test.ts` | **50/50** (was 40; +10 unread tests) |
| `tests/wallet.test.ts` | 29/29 — **79 combined, 0 fail** |
| `npx prisma validate` | valid |
| `CI=true npx next build` | exit 0 |
| CI "Build & typecheck" on `892e209` | **success** (14:54:31Z → 14:55:59Z) |
| Deploy `37328850999` (workflow_dispatch) | build success; deploy job — **see §2.1** |

### 2.1 ⚠ NOT YET PROVEN LIVE — your first job

The deploy run `37328850999` was still executing its "Deploy to production" job when this
handoff was written. **Check it yourself and report per job, not per run.** If it failed,
the marketing copy and the Cyber Lab claim are NOT live and §5 changes accordingly.

Cheapest live-prove for the new routes — **401, not 405 / not 404**, is the proof they are
deployed (a 405 means the handler is absent):
```
POST /api/support/tickets/<some-id>/read   -> 401 unauthenticated, NOT 405
GET  /api/overview-stats                   -> 401 unauthenticated, NOT 404
```

### 2.2 What `892e209` contains, for verification

**Unread (TASK_166)**
- `SupportTicket.lastReadAt` — nullable, **no backfill, no default** (`NULL` = never read,
  deliberately, so a reply already waiting is surfaced). Migration
  `prisma/migrations/20261111000000_task166_support_unread/`.
- `markTicketRead()` in `lib/support/tickets.ts` — moves the cursor **forward only**, for
  the caller's **own** ticket; another user's id **404s, not 403s** (not an existence
  oracle).
- `POST /api/support/tickets/[id]/read` — own route dir because a Next.js route module
  exports one handler per method and `[id]/messages` already owns POST for that id.
- Per-ticket `unread` **boolean** derived from one row (newest message + `lastReadAt`) —
  **not** a per-ticket COUNT query. Verify the reasoning holds: a wrong badge number is
  worse than a coarser true one.
- Badge count, dot on the collapsed button, WebAudio chime, 45s poll.

**Status row (P3)**
- `GET /api/overview-stats` — one session-scoped read for the whole row.
- **No `userId` parameter anywhere.** The id must come from the cookie only. Verify by
  grep, not by reading the happy path.
- **Integer units:** wallet in CENTS, AI in HUNDREDTHS OF A CENT. Neither divided on the
  server.
- AI usage summed via `lib/ai-metering`, so it is by construction the same number the
  agent's cap check enforces.
- Rate-limited with a **new** limiter kind `"overview-stats"`.

**Marketing**
- Five pillars; grid changed to `md:grid-cols-2 lg:grid-cols-3` (five tiles in a 3-wide
  grid leave a ragged 3+2 row).
- Hosting as available — verify every claim maps to a real shipped surface in
  `components/hosting-panel.tsx`.
- Cyber Lab as available, **bounded** to "authorised" / "your own systems" / "consent
  recorded per run", mirroring `lib/lab/gate.ts`. The previous agent deliberately did NOT
  write "test any target" — check that bound is intact.

### 2.3 A mistake the previous agent made — do not repeat it

It first wrote the `lastReadAt` migration into
`prisma/migrations/20261110000000_task159_support_tickets/`, whose timestamp collides with
the **wallet** migration (`20261110000000_task158_wallet`). It was moved to
`20261111000000_task166_support_unread` before commit. **Verify the canonical task159
migration (`20261107000000`) and the task158 wallet migration are untouched**, and that
the five directories are strictly increasing and non-colliding:
```
20261105000000_task157_user_domains
20261106000000_task158_zone_token
20261107000000_task159_support_tickets
20261110000000_task158_wallet
20261111000000_task166_support_unread
```
A duplicate migration timestamp on a production box is a failed deploy, not a warning.

---

## 2.4 ⚠ WORK ITEM A — the wallet has NO funding path. This is your main job.

**Work from `PLAN_TASK_167_WALLET_TOPUP.md`.** Read it first; it is short and cites
`PLAN_TASK_158` §4–§9.

The owner asked mid-session: *"hope we have the add funds in wallet that leads to the
payment path, and not only for subscription… which is the wallet plan."*

**Verified answer: NO, and this is not a UI gap — the functions have no caller at all.**

| Function | Location | Production callers |
|---|---|---|
| `creditTopup()` | `lib/wallet.ts:431` | **ZERO** — only `tests/wallet.test.ts` |
| `adminAdjustBalance()` | `lib/wallet.ts:567` | **ZERO** — and there is **no `app/api/admin/wallet` directory** |
| `creditApprovedPayment()` | `lib/wallet.ts:487` | **ZERO** |

Re-run that grep yourself. The owner's instinct is correct, and the consequence is that a
**user's balance is `$0.00` in production today and always will be** until W3 + W4 exist.

Two things the next agent must NOT get wrong:

1. **`components/wallet-chip.tsx:28-33` documents this on purpose** — the chip renders an
   explicit "no funds yet" state instead of a bare `$0.00`, and the comment says the chip
   *will* read `$0.00` for every real user. **That comment is TRUE.** Update it in the same
   commit the top-up ships; do not delete it earlier to "clean up".
2. **⚠ TWO UNRELATED THINGS BOTH USE THE WORD "WALLET".** The error the owner hit locally,
   `"Wallet not configured"`, is `app/api/billing/checkout/route.ts:69` and
   `app/api/billing/submit/route.ts:116` — it means `AdminSetting.btcWallet` / `usdtWallet`
   / `usdtErc20Wallet` (the **crypto payout address**) is blank locally. It is **not** the
   SpaceWorker wallet, and it is configured in production. Do not chase the wrong one.

**Scope: W3 and W4 only.** W5 (`/api/wallet/spend`) and W6 (EXE-from-wallet) are OUT.
The highest-risk line in the whole plan is the 4b branch on the admin approve route: a
`wallet_topup` must credit the wallet, and **every other product must behave exactly as it
does today**. The owner sells subscriptions and EXE licences through that route; a
regression there hands a paying customer a wallet balance instead of a licence.

---

## 2.5 The previous handoff's gates (for continuity)

Those were run by the **verifier**, not self-reported, and remain the baseline:

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean, 0 errors |
| `npx eslint` on all 6 touched files | clean, 0 |
| `npx eslint 'app/admin/(protected)/admin-panel.tsx'` | **44 errors — PRE-EXISTING**, see CORRECTED 2 |
| `npm run test:support` | 40/40 (at that commit) |
| `npm run test:wallet` | 29/29 |
| `npm run test:lab` | 10/10 |
| `npm run test:hosting` | 334/334 |
| `CI=true npm run build` | exit 0 |

Deploy `37305909697` — "Build & typecheck" success, "Deploy to production" **success**,
log shows `rm -rf /opt/spaceworker/.next` **before** `tar xzf` (fresh build, not stale),
systemd unit assertions passed.

Live checks (unauthenticated): `GET /dashboard/billing` → 200;
`POST /api/admin/support/tickets` → **401 and specifically NOT 405** (the 401-not-405 trick
is what proved the new endpoint was live; reuse it above).

   never ran is OUTSTANDING, not green.
7. Scratch databases only. Never run a destructive migration against anything that is not a
   throwaway DB you created this session.
8. `gh workflow run deploy.yml --ref main` is the only deploy path. The deploy job is manual-only;
   a push-triggered run reporting success may have SKIPPED the deploy job. Always check the job
   list, not the run conclusion.
9. Delete every temporary script from BOTH `/tmp` and `/opt/spaceworker` when done.
   `scripts/stub-server-only.cjs` is a TRACKED repo file — restore it if you overwrite it.
10. **Never use a shell heredoc for multi-KB file content.** It corrupts the file through the
    terminal wrapper. On 2026-10-05 an 8.8KB `cat >> SENIOR_HANDOFF.md <<'EOF'` left the file
    garbled and needed `git checkout --` to recover. Write content with your editor tool, then
    `cat smallfile >> target`. Also: after every commit, run `git log -1` and confirm the commit
    actually happened — a mangled command can leave it NOT made while appearing to have run.
11. **Never `git stash` to get a lint baseline.** An interrupted stash on 2026-10-05 left an
    untracked file in a conflicted index state. Use a throwaway worktree instead — see §2 TRAP 1.

### ⚠ THREE CLAIMS THE PREVIOUS AGENT GOT WRONG — do not repeat them

**CORRECTED 1 — the admin-composed ticket does NOT take its owner from the admin session.**
The previous prompt's step-2 line said: *"confirm the target user id comes from the admin
session, never the request body."* **That instruction is impossible to satisfy and would have
failed a correct implementation.** `lib/admin-auth.ts` shows the admin session is a single shared
passcode whose subject is the literal string `"admin"`. There is no admin user id to forward — a
route that read one would be reading the literal `"admin"`. So `POST /api/admin/support/tickets`
takes **`userEmail`** and resolves it server-side against `User.email`. The §2.2 invariant ("owner
from the session") governs the **customer** route, where the session names exactly one person, and
it is intact there. What actually preserves the security intent on the admin side is:
  1. `requireAdminSession()` runs **BEFORE `request.json()`** — an unauthenticated caller is
     rejected without the body being read, so the endpoint cannot be used to probe which emails
     have accounts. *(Verified in source: in `app/api/admin/support/tickets/route.ts`, the gate is
     the first statement in `POST`.)*
  2. There is **no id parameter to forge** — an email must correspond to a real `User` row.
  3. The **customer** route gained no new parameter: `postSchema` in
     `app/api/support/tickets/route.ts` still has no `userId` field, and `userId` comes from
     `getCurrentUser()`. Verified by test 39, "D4 no customer route can name a target user".
  4. The email is lowercased before lookup, because `User.email` is `@unique` and two spellings of
     one address must not resolve differently.
  `domainRefId` is **deliberately absent** from the admin path — an admin-attached domain would
  bypass `resolveOwnedDomain`'s `ownerUserId` check, which is the only thing keeping a ticket's
  domain on the customer's own account (§3.3).

**CORRECTED 2 — the "44 ESLint errors are pre-existing" claim was checked, not accepted.**
The previous agent asserted a baseline it established with `git stash`, which is exactly the
operation that caused the index conflict (TRAP 1). It happens to be **correct**, but it was never
properly established. The verifier re-established it safely in a detached worktree:
```
git worktree add /tmp/sw_head_check HEAD --detach
ln -s /Users/mikeolab/spaceworker/node_modules /tmp/sw_head_check/node_modules
cd /tmp/sw_head_check && npx eslint 'app/admin/(protected)/admin-panel.tsx'   # → 44 errors
rm -f /tmp/sw_head_check/node_modules && git worktree remove /tmp/sw_head_check --force
```
44 at HEAD, 44 with the changes. **Confirmed pre-existing. Do not re-litigate, and do not "fix"
them inside a feature commit** — they are all `react-hooks/set-state-in-effect`.

**CORRECTED 3 — the local build needs `CI=true`, and this is environmental, not a defect.**
The previous agent hit a `SESSION_SECRET` placeholder guard and correctly diagnosed it:
`lib/env.ts` throws only when `NODE_ENV=production` **and** `CI` is unset, and the local `.env`
holds a `local_dev_…` value. `CI=true npm run build` is what your real deploy does, and it exits 0.
**Use `CI=true` for every local build. Do not "fix" `.env` (rule 3).**

### TRAPS baked into this handoff

**TRAP 1 — DO NOT `git stash`.** Use a worktree for baselines (CORRECTED 2). On 2026-10-05 an
interrupted `git stash` left `TASK_133_RMM_ENGINE_BRINGUP.md` in a conflicted index state. That
file is **untracked at HEAD, is NOT part of `stash@{0}`, and belongs to the owner's pre-existing
`self-hosted-build` stash.** Its contents were verified intact and the index marker cleared with
`git reset -- <path>`, restoring it to plain untracked. **`TASK_133_RMM_ENGINE_BRINGUP.md` is
still untracked in the repo right now. Leave it alone. Never `git add -A`, never `git stash`.**
`git add` only the specific paths you intend to commit. The owner should separately check
`stash@{0}: On self-hosted-build: self-hosted-build WIP: TASK_133 spec`.

**TRAP 2 — `POST` returning 401 proves new code is live; 405 proves it is not.** The old code had
no `POST /api/admin/support/tickets` handler, so Next would answer 405. Use the status code to
distinguish "route exists but gated" from "route absent". Same trick as the wallet card's
`GET /api/wallet` → 401 (not 404) ⇒ mounted.

**TRAP 3 — the shell mounts the support widget BOTTOM-LEFT on purpose.**
`components/agent-widget.tsx` already owns **bottom-right**. Both widgets are gated on
`!buildTarget` because `/api/support/**` and `/api/agent` are Prisma-backed and the EXE ships
without `DATABASE_URL`. If a future agent "tidies up" the position into one corner, the lower
widget becomes **unclickable** and support silently vanishes. Do not move it.

**TRAP 4 — the EXE nav is narrowed by an allow-list, not a deny-list.**
`components/dashboard-nav.tsx:75` — `BUILD_ALLOWED_HREFS.extractor` contains exactly
`/dashboard`, `/dashboard/extract`, `/dashboard/settings`. **Anything not in that Set is silently
dropped from the EXE.** So the new `Billing` entry is auto-excluded from the extractor build with
no extra work. When you add a nav entry, confirm you *want* it excluded (web-only ⇒ do nothing) or
add it to the Set deliberately. Never assume an entry is in both builds.

**TRAP 5 — `status` on `SupportTicket` has NO database CHECK constraint.** It is an extensible
string. One typo creates a status that **no queue filter matches, and the ticket silently vanishes
from every view.** This is why the admin panel offers only Resolve/Reopen and has **no status
free-text box**. If you add a status field, add a CHECK or an enum — do not repeat this.

**TRAP 6 — the credential scan only reads TEXT.** There is deliberately **no file upload** on the
support composer. A file input would build the exact paste-target that §2.1 exists to prevent,
while the UI claimed the feature was safe. `validateSubject` / `validateBody` are the **same
functions** on the admin and customer paths — keep it that way. A future agent adding attachments
must add a real content scan first, or the guarantee is gone.

**TRAP 7 — `git log -1` after every commit** (rule 10). A mangled command can leave a commit NOT
made while appearing to have run.

**TRAP 8 — live BUILD_ID check.** A stale `BUILD_ID` with a green run is the classic
false-positive. The deploy removes `/opt/spaceworker/.next` before extracting, so confirm that
line is in the run log and the mtime falls inside the job window.

**TRAP 9 — SSH to the VPS prompts for a password** in a non-interactive shell. `VPS_SSH_KEY` is
a GitHub secret, not on your machine. **Verify live over `curl` against
`https://spaceworker.top`, not over SSH.** Do not report a box-level check you could not run.

**TRAP 10 — `test:support` counts will move.** 40/40 is the baseline *including* the 10 new D4
tests. If a count drops, the suite is being edited, not the code being fixed — read the diff.

**TRAP 11 — THE WALLET CANNOT BE FUNDED YET. Every real user sees `$0.00`.**
This is the most misreadable thing in the current build. `lib/wallet.ts` **has** `creditTopup`
(`:431`), `creditApprovedPayment` (`:487`) and `adminAdjustBalance` (`:567`) — but `grep -rn` proves
**no production route calls any of them**; the only hits are `lib/wallet.ts` itself and
`tests/wallet.test.ts`. They are unit-tested and unwired. `POST /api/wallet` is **405** (GET only),
and there is no `/api/wallet/grant`, `/api/billing/topup` or `/api/wallet/spend`.
**What does exist is a TIER purchase flow** — `POST /api/billing/submit` creates a `Payment` with
`status: "pending"` (`app/api/billing/submit/route.ts:133-142`) for manual admin review, and
approving it does **not** credit a balance. **The owner's instruction to have no "Add funds" flow is
therefore easy to satisfy: it was never built.** Only `PLAN_TASK_158` W3 (admin grant) can make a
balance non-zero, and it is deliberately deferred. **So a Wallet chip reading `$0.00` is correct
behaviour, not a bug — do not "fix" it, and treat any fabricated balance as a blocker.**

**TRAP 12 — `getWallet()` is SERVER-ONLY.** The client must fetch `GET /api/wallet`, exactly as
`components/wallet-balance.tsx` already does. A client component importing `@/lib/wallet` is a
blocker. This is `PLAN_TASK_158` §4 rule 2 and it is easy to violate when a balance first appears in
a new surface.

**KNOWN OUTSTANDING (do not treat as done):**
- The wallet card's **visual render with a real session has still never been observed.**
  Anonymous `GET /dashboard/billing` used to be a 307 to `/login`; it is now **200** (the page
  builds and serves) but that still says nothing about what a logged-in user sees.
- ~~**`Mailboxes` has a `DESCRIPTIONS` entry but NO `NAV_ITEMS` entry**~~ — **RESOLVED AS A NON-ISSUE
  (owner, 2026-10-05).** The previous handoff called this an unreachable-page defect. **It was
  wrong.** `app/dashboard/mailboxes/page.tsx:11` is `redirect("/dashboard/campaigns?tab=mailboxes")` —
  mailboxes are a tab inside Campaigns, which is where the owner wants them. Same for
  `/dashboard/browser-profiles` → `/dashboard/browser?tab=profiles` and `/dashboard/licenses` →
  `/dashboard/settings#licenses`. **There is no orphaned-page defect, and no one should "fix" it by
  adding a `NAV_ITEMS` entry** — that would duplicate a tab that already exists.
  **The real defect this masked was in `app/dashboard/page.tsx:26-37`:** a hardcoded allow-list
  filter whose `i.href === "/dashboard/mailboxes"` condition can never match, so it silently drops
  every newly added app. That is what hid Billing. **It is fixed in `29bfbbc` (P2) — confirm it
  is gone rather than assuming.**
- Stock-video licences for D2 remain **unverified** (Pexels/Pixabay return 403 to automated
  fetches; Mixkit's terms load from JS).
- `AdminSetting.cyberlabEnabled = false` in production (Cyber Lab is dark) while the owner has
  decided to advertise it. **The marketing copy HAS NOW LANDED in `892e209` and the owner said he
  would flip the switch the same night. Verify the live value and report it — see the header
  and §5 item 4.** This is the one open inconsistency between the marketing page and the product.
- `app/dashboard/billing/page.tsx` has **2 pre-existing** ESLint errors
  (`react-hooks/set-state-in-effect`).

## 3. WORK ITEM A — verify `892e209`, then build the wallet top-up

### 3A. Verify the shipped commit FIRST, before writing any new code

Step 0 — git state, do not guess it:
```
git fetch origin && git status --short && git log --oneline -5
```
Confirm `TASK_133_RMM_ENGINE_BRINGUP.md` is still untracked and **untouched** (TRAP 1),
and nothing else unexpected is in the tree.

Step 1 — the deploy (§2.1). **If run `37328850999`'s deploy job did not succeed, stop and
report that first** — everything below assumes the marketing copy is live.

Step 2 — the gates (these are the previous agent's self-report; make them your own):
```
npx tsc --noEmit
npx eslint <the 8 touched files>
npx tsx --test tests/support-tickets.test.ts tests/wallet.test.ts   # expect 79 pass
npx prisma validate
CI=true npm run build
```

Step 3 — the claims, each with `file:line`:
  * **`cyberlabEnabled` in production.** The owner said he is flipping it. **Check the real
    value and report it.** Still `false` ⇒ the live site advertises a product whose own
    panel says "Not available yet" — a real finding, not a nit.
  * **Migration order is strictly increasing and non-colliding** (§2.3), and the task159
    and task158-wallet migrations are byte-identical to `origin/main`.
  * **`markTicketRead` is forward-only and owner-scoped**, and 404s (not 403s) another
    user's ticket.
  * **`GET /api/overview-stats` has no `userId` parameter** — grep, don't read the happy
    path. Confirm money stays integer (CENTS / HUNDREDTHS OF A CENT), nothing divided
    server-side.
  * **Live:** `POST /api/support/tickets/<id>/read` unauth → **401, not 405**;
    `GET /api/overview-stats` unauth → **401, not 404**.
  * **You cannot see a rendered badge without a real session.** Say so plainly rather than
    claiming the notification "works".

### 3B. Then build it — `PLAN_TASK_167_WALLET_TOPUP.md`, W3 then W4

Read `PLAN_TASK_167_WALLET_TOPUP.md` and `PLAN_TASK_158` §4–§9 first. The short version:

  * **W3** `POST /api/admin/wallet/grant` + admin panel section. Admin check BEFORE
    `request.json()`; every credit carries `adminId`; a replayed `idempotencyKey` 409s;
    negative amounts land as `admin_adjust`, not `admin_grant`.
  * **W4a** `POST /api/billing/topup` — opens a `wallet_topup` payment and **credits
    nothing**. Amount validated against an admin-configured minimum.
  * **W4b** Branch the admin approve route on `product`. `wallet_topup` → guarded credit
    into the wallet, writing `topup` + `creditedCents` + `adminNote`, granting **no**
    entitlement. **Every other product behaves exactly as today.**
  * **A top-up never auto-credits.** On-chain confirmation is not payment.
  * **Credit + payment status in one transaction.**

**The line most likely to cause real damage is W4b's non-topup branch.** A paying customer
buying a subscription or an EXE licence must not receive a wallet balance instead. That
regression is invisible in casual testing and expensive in production.

**Commit discipline (money is not UI):** W3, then W4 routes, then W4 UI — separate commits,
each pushed and deployed on its own (`PLAN_TASK_165` §5 rule 1, `PLAN_TASK_167` §5).

Step 4 — deploy each commit: `git push origin main`, then
`gh workflow run deploy.yml --ref main`. **Confirm the DEPLOY JOB ran (not skipped) — check
the job list, never the run conclusion.** Confirm `.next` was removed before extraction and
the BUILD_ID mtime is inside the job window. If anything is left uncommitted, `git add`
specific paths only, commit with `-F<file>`, and confirm with `git log -1` (TRAP 7).

## 4. WORK ITEM B — the owner's locked decisions. Do NOT relitigate these.
  **D1 WALLETPAPER: PAUSED.** No per-user wallpaper isolation, so custom wallpaper uploads are
     out of scope. Revisit only if per-user isolation becomes a one-migration change.
  **D2 3D CENTREPIECE: REAL 3D, as a free looping VIDEO ASSET** (robot running around a
     space/globe), preset options, users upload nothing, and it must also be used on the
     MARKETING page. Scoped in `TASK_161` §2 D6. **The licence check is still open** — see the
     "must report" note below.
  **D3 MARKETING COPY:** Hosting AND Cyber Lab are both advertised NOW (the owner is finishing
     Cyber Lab this week); domains are "coming soon". Scoped in `PLAN_TASK_164_MARKETING_COPY.md`.
     **D3 IS NOW PARTIALLY SHIPPED in `892e209`** — Hosting and Cyber Lab are on the landing
     page as live capabilities, the pillars went 3 → 5, and the grid became
     `md:grid-cols-2 lg:grid-cols-3`. Two things to check: **domains were deliberately NOT
     added as a pillar** (confirm that is still intended), and the Cyber Lab copy stayed
     bounded to "authorised" / "your own systems" / "consent recorded per run" rather than
     drifting into "test any target". The `<h1>` and metadata were aligned to the real page.
  **D4 STORE:** dropdown multi-select, total computed SERVER-SIDE, purchase linked to the user's
     EMAIL. `PLAN_TASK_162` §6–8. Start with S0 (verify whether email linkage already works).
  **D5 SELF-HOST, devices-first:** V1 = sell `devices` standalone (`DEVICES_MODULE`) — cheap,
     unblocked, and the owner's stated priority. V3 = fix the live bug where mailer/combined/
     automation EXEs leak the full web nav. `PLAN_TASK_163` §5A–5B.
  **D6 WALLET:** W3 + W4 only — `PLAN_TASK_167_WALLET_TOPUP.md`. **W5
     (`POST /api/wallet/spend`) and W6 (EXE-from-wallet) remain unbuilt and are explicitly
     OUT of scope.** A wallet with no way to spend it is a smaller problem than one where a
     debit path ships without a credit path to feed it.

**If D2 reaches the licence question, report it as a BLOCKER, do not assume.** Pexels and Pixabay
return HTTP 403 to automated fetches and Mixkit's terms load from JS modals. Confirming a licence
that permits commercial use + distribution inside a product needs a human in a browser. Record
per asset: source URL, exact licence name, licence URL, date fetched, asset id — in a tracked file
such as `ASSETS_LICENCE.md`.

Then append to `SENIOR_HANDOFF.md`: what shipped, what is verified live, what is still
outstanding, and any new trap you hit. Use the editor tool for long content, then
`cat smallfile >> SENIOR_HANDOFF.md` — **never a heredoc** (rule 10).

## 5. Report back — exactly these items
1. Gate results table: every command, its real output, pass/fail/**outstanding**. Never summarise
   a check you did not run.
2. Deploy evidence: run id, job names + conclusions (deploy job present or skipped), BUILD_ID
   mtime vs run start, live curl results.
3. Claim-by-claim verdict on the work item: confirmed or refuted, with `file:line`.
4. **The `cyberlabEnabled` production value, stated plainly.** If it is still `false`, say so
   directly and name the consequence: the marketing page claims a product the lab panel
   denies. Do not soften it, and do not fix it yourself.
5. **The wallet's zero-caller result, re-verified by you** — not taken from §2.4 on trust.
   Give the grep you ran and its output.
6. Any blocker, with the exact reason. If you cannot verify something, **say so plainly** rather
   than assuming.
7. For D2/D3/D4/D5/D6: what you scoped, and the open questions you deliberately did not guess.
8. Cleanup confirmation: scratch DBs dropped, temp scripts deleted from BOTH machines,
   `git worktree list` showing **only** your intended worktrees, `git status --short` state
   (it should still show `?? TASK_133_RMM_ENGINE_BRINGUP.md` and nothing else unexpected),
   and whether production was modified.
9. The next agent's prompt, ready to paste.
