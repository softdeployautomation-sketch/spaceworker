# PROMPT — NEXT VERIFICATION AGENT (starts from commit `5d3b893b`, deployed & live)

> ## ★ WHAT CHANGED SINCE THE LAST HANDOFF — read this first
>
> The **support batch is now SHIPPED, COMMITTED, PUSHED and LIVE-VERIFIED.** Commit
> **`5d3b893b`** on `main`, deployed in run **`37305909697`**. Do not re-verify it as
> uncommitted work and do not re-commit it. Your job starts at **wallet W3**.
>
> The previous verifier did the verification work that agent asked for, and the
> agent's own claims were checked line by line rather than trusted. Three of its
> claims needed correcting — they are listed in §2 as **CORRECTED**, so you do not
> repeat them.

---

## 1. MANDATORY reading, before any command
  /Users/mikeolab/spaceworker/HOW_WE_MOVE_FAST.md
  /Users/mikeolab/vantra/TASK_MANAGEMENT_PLAYBOOK.md
  /Users/mikeolab/spaceworker/SENIOR_HANDOFF.md
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
## 2. Verified state as of handoff (2026-10-05)

Branch `main`, HEAD **`5d3b893b`**, **0 ahead / 0 behind** origin/main.

Recent history (newest first):
  5d3b893 feat(support): customer widget, admin queue, admin-composed tickets, Billing nav
  8c8b4b6 docs: scope the OS dashboard (3D video + support schema), marketing copy, store cart, self-host
  231ae31 feat(wallet): W2 step 1 — authenticated GET /api/wallet and a read-only balance card
  5a5c07e test(wallet): dry-run the wallet migration against a clone of PRODUCTION
  4a7e06c docs: scope the OS dashboard, store multi-select, and devices-first self-host
  5462981 feat(wallet,hosting): wallet ledger with guarded CAS and a real Zones capability probe

**The support batch — every gate below was run by the verifier, not self-reported:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean, 0 errors |
| `npx eslint` on all 6 touched files | clean, 0 |
| `npx eslint 'app/admin/(protected)/admin-panel.tsx'` | **44 errors — PRE-EXISTING**, see CORRECTED 2 |
| `npm run test:support` | **40/40** (was 30; +10 D4 tests) |
| `npm run test:wallet` | 29/29 |
| `npm run test:lab` | 10/10 |
| `npm run test:hosting` | 334/334 |
| `CI=true npm run build` | exit 0 |

**Deploy run `37305909697` (`workflow_dispatch`) — deploy job PRESENT, not skipped:**
  - "Build & typecheck" → **success** (11:54:08Z → 11:55:17Z)
  - "Deploy to production (manual only)" → **success** (11:55:20Z → 11:59:22Z)
  - Deploy log shows `rm -rf /opt/spaceworker/.next` **before** `tar xzf` — fresh build, not stale
  - systemd unit assertions passed (the job would have failed otherwise)

**Live checks over real HTTP (unauthenticated):**
  - `GET /dashboard/billing` → **200**
  - `POST /api/admin/support/tickets` → **401**, and specifically **NOT 405** — the old code had
    no POST handler at all, so a 405 would have meant the new endpoint was absent. **401 is the
    proof the new route is live.** This is the cheapest live-proves-new-code trick available.
  - `GET /api/admin/support/tickets` → 401 · `GET /api/support/tickets` → 401
  - `POST /api/support/tickets` with a forged `userId` in the body, unauthenticated → 401

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
  **The real defect this masked is in `app/dashboard/page.tsx:26-37`:** a hardcoded allow-list filter
  whose `i.href === "/dashboard/mailboxes"` condition can never match, so it silently drops every
  newly added app. That is what hid Billing, and it is fixed by the current work item below.
- Stock-video licences for D2 remain **unverified** (Pexels/Pixabay return 403 to automated
  fetches; Mixkit's terms load from JS).
- `AdminSetting.cyberlabEnabled = false` in production (Cyber Lab is dark) while the owner has
  decided to advertise it. Marketing copy must land with the switch flip.
- `app/dashboard/billing/page.tsx` has **2 pre-existing** ESLint errors
  (`react-hooks/set-state-in-effect`).

## 3. WORK ITEM A — OS dashboard redesign: Wallet chip + overview-only side nav

Scope: `PLAN_TASK_165_OS_DASHBOARD_REDESIGN.md` **P1 and P2**. The feature agent works from
`PROMPT_NEXT_FEATURE_AGENT.md`. **Two separate commits are expected** — verify they are separate and
that each is independently deployable.

⚠ **The old Work Item A in this file said "verify wallet W3". That is superseded.** W3 is deferred:
it is money-adjacent and must not ride along inside a UI commit. It remains the next *money* task
after this one.

Step 0 — before touching code:
  a. `git fetch origin && git status --short && git log --oneline -5` — confirm sync and what is in
     flight. **Do not guess the git state.**
  b. Read the diff of every changed path. **Do not rubber-stamp it.**
  c. Confirm no unrelated changes are swept in, and that `TASK_133_RMM_ENGINE_BRINGUP.md` is still
     untracked and **untouched** (TRAP 1).

Step 1 — the gate, before each commit:
    npx tsc --noEmit · npx eslint (touched files only)
    npm run test:wallet (29) · test:support (40) · test:hosting (334)
    CI=true npm run build

Step 2 — verify the claims, do not assume them:
  * **Billing left the dock.** `NAV_ITEMS` in `components/dashboard-nav.tsx` must have **no**
    `/dashboard/billing` entry, and a **Wallet chip must exist in `components/menu-bar.tsx`** linking
    to `/dashboard/billing`. **If the entry is merely hidden rather than deleted, that is a failure** —
    `NAV_ITEMS` is the single source of truth and a hidden entry reappears in the dock.
  * **The chip reads the balance over HTTP, not by importing the service.** `getWallet()` is
    **server-only**. Grep the chip for any client-side `import ... from "@/lib/wallet"` — if present,
    it is a **blocker**, not a style note.
  * **No fabricated balance.** The wallet cannot be funded yet — see §3 of the plan. The chip will
    read `$0.00` for every real user. **A hardcoded or optimistic balance is a release blocker.**
    Confirm no top-up/"Add funds" flow was invented to paper over it.
  * **Build-target narrowing did not regress.** `BUILD_ALLOWED_HREFS.extractor` must still yield only
    Overview/Extract/Settings. Removing a Billing entry cannot affect the EXE (Billing was never in
    that set) — **verify, don't assume.**
  * **The sidebar renders on the OVERVIEW ONLY.** If it is added to `components/shell.tsx`, it shows
    on every page and contradicts the request. Confirm it is `hidden md:flex` and does not overlap
    the bottom dock (`components/dock.tsx:19`).
  * **The dead filter is gone.** `app/dashboard/page.tsx` must no longer contain the hardcoded
    allow-list with the never-matching `i.href === "/dashboard/mailboxes"` condition. **If that
    filter survives, the fix was cosmetic** — the class of bug (new apps silently hidden) is intact.
  * **No dead data left behind.** Removing the cards removes the only reader of `DESCRIPTIONS`
    (`app/dashboard/page.tsx:12-22`). Either delete it or confirm something still reads it.
  * **`Mailboxes` was NOT added to `NAV_ITEMS`.** If the agent "fixed" the non-issue, reject the
    change — it duplicates a tab that already exists inside Campaigns (§2).
  * **Support widget has not moved.** It is bottom-left because `AgentWidget` owns bottom-right.
  * **No wallet/admin-grant route was added** in a UI commit (TRAP: money inside a UI change).

Step 3 — deploy and prove live:
  * `git push origin main`; `gh workflow run deploy.yml --ref main`.
  * Confirm the **DEPLOY JOB** ran (not skipped) — check the **job list**, not the run conclusion.
  * Confirm `.next` was removed before extraction and the BUILD_ID mtime is inside the job window.
  * Live over `curl` (SSH prompts for a password — TRAP 9): `GET /dashboard/billing` → expect a real
    200/307, and `GET /api/wallet` unauthenticated → **401, not 404** (mounted) and **not 200**.
  * **You cannot see a rendered chip without a real session** — say so plainly rather than claiming
    the Wallet chip "works". Anonymous HTML proves the page serves, not that the chip renders.

Step 4 — commit and deploy if the agent left work uncommitted. `git add` specific paths only;
commit with `-F<file>`; confirm with `git log -1` (TRAP 7).

## 4. WORK ITEM B — the owner's locked decisions. Do NOT relitigate these.
  **D1 WALLETPAPER: PAUSED.** No per-user wallpaper isolation, so custom wallpaper uploads are
     out of scope. Revisit only if per-user isolation becomes a one-migration change.
  **D2 3D CENTREPIECE: REAL 3D, as a free looping VIDEO ASSET** (robot running around a
     space/globe), preset options, users upload nothing, and it must also be used on the
     MARKETING page. Scoped in `TASK_161` §2 D6. **The licence check is still open** — see the
     "must report" note below.
  **D3 MARKETING COPY:** Hosting AND Cyber Lab are both advertised NOW (the owner is finishing
     Cyber Lab this week); domains are "coming soon". Scoped in `PLAN_TASK_164_MARKETING_COPY.md`.
     ⚠ **The Hero already matches the proposed copy word for word — do NOT rewrite it.** The
     actual gap is the pillars.
  **D4 STORE:** dropdown multi-select, total computed SERVER-SIDE, purchase linked to the user's
     EMAIL. `PLAN_TASK_162` §6–8. Start with S0 (verify whether email linkage already works).
  **D5 SELF-HOST, devices-first:** V1 = sell `devices` standalone (`DEVICES_MODULE`) — cheap,
     unblocked, and the owner's stated priority. V3 = fix the live bug where mailer/combined/
     automation EXEs leak the full web nav. `PLAN_TASK_163` §5A–5B.

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
4. Any blocker, with the exact reason. If you cannot verify something, **say so plainly** rather
   than assuming.
5. For D2/D3/D4/D5: what you scoped, and the open questions you deliberately did not guess.
6. Cleanup confirmation: scratch DBs dropped, temp scripts deleted from BOTH machines,
   `git worktree list` showing **only** your intended worktrees, `git status --short` state
   (it should still show `?? TASK_133_RMM_ENGINE_BRINGUP.md` and nothing else unexpected),
   and whether production was modified.
7. The next agent's prompt, ready to paste.
