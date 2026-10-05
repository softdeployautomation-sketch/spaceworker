# PROMPT A — Feature agent: Billing tab, wallet in the UI, finish Support

Copy everything below the line into the next feature-agent session.

---

You are the FEATURE agent for SpaceWorker. You own the code. Another senior agent already
verified and deployed the wallet W2 work you are continuing from — you do not need to re-verify it.

REPO: `/Users/mikeolab/spaceworker` (branch `main`)

## 0. READ FIRST (binding)
  cat SENIOR_HANDOFF.md          # §0 and §10 are binding on you
  cat HOW_WE_MOVE_FAST.md       # deploy + verification playbook
  cat TASK_161_DASHBOARD_OS.md   # your scope for tasks 2 and 3
Then run `git status` and `git log --oneline -3` before touching anything. If there are unrelated
uncommitted changes, do not touch or discard them — another agent likely has work in flight.

**Current verified state:** `main` @ `231ae31`, 0 ahead / 0 behind origin. Deployed run
`37292940559`, live `BUILD_ID WvCKpRBOukDSlI74eeF7T`. Migration
`20261110000000_task158_wallet` IS applied in production. `GET /api/wallet` IS live and returns
401 unauthenticated. **Step 1 below is about making it VISIBLE, not about building it again.**

## TASK 1 — Add a Billing entry to the nav so the owner can see the wallet card

**This is first because the owner already reported "I see no billing page or tab right now", and
that report is CORRECT.** The wallet card is live at `/dashboard/billing` but that route is not in
`NAV_ITEMS` (`components/dashboard-nav.tsx:37-59`), so there is no way to click to it.

- Add `{ href: "/dashboard/billing", label: "Billing", icon: <CreditCard|Receipt> }` to
  `NAV_ITEMS`, in the same style as the existing entries, with a short comment saying why.
- **Read `NAV_ITEMS` first.** Note that `Mailboxes` is described in `DESCRIPTIONS` but has NO nav
  entry either — a known separate defect. Do **not** fix it in this commit; note it.
- **Do not regress build-target narrowing.** `BUILD_ALLOWED_HREFS` (`:64-66`) has only an
  `extractor` entry today, so a new nav item WILL leak into the mailer/combined/automation EXEs
  along with everything else. That is pre-existing (see `PLAN_TASK_163` §5A V3) — do not fix it
  here, but say so in your commit message.
- Verify the wallet card actually renders for a signed-in user. **You cannot do this with `curl`:
  anonymous `GET /dashboard/billing` is a 307 to `/login` and proves nothing.** Either sign in for
  real, or state plainly in your report that the visual render is unverified. Do not claim you
  saw it if you did not.

## TASK 2 — Wallet: close out the remaining W2 surface
W2 step 1 (read route + read-only card) is **shipped and live**. Per
`PLAN_TASK_158_WALLET_BALANCE.md` §W2, the remaining work is W3 (admin grant) and W5 (spend) —
**they are separate tasks and must stay separate.** For this session:
- Read `PLAN_TASK_158_WALLET_BALANCE.md` and report which W-step is next.
- If the next step is **W3 (admin grant)**, scope it and confirm the plan before writing code.
- **Hard rules:** `lib/wallet.ts` stays price-agnostic and is the ONLY writer of
  `User.balanceCents`; the ledger is append-only (no update/delete on `WalletLedgerEntry`, ever);
  every mutation is a guarded conditional `updateMany` whose `count === 0` is the failure signal;
  debit+entitlement and credit+payment-status each commit in ONE transaction or not at all; no
  float money, integer cents end to end.
- **Never add a way for a client to POST an amount to the wallet.** Credits only ever come from a
  server-proven payment. The existing route has no POST (it 405s) and must stay that way.

## TASK 3 — Support: finish the UI, then the admin-composed ticket
Backend is **done** (6 authenticated routes, `lib/support/tickets.ts`). There is **no UI at all**,
so today a customer cannot open a ticket. Scope is `TASK_161` §2 D3 and D4 — read them, detailed.


## NON-NEGOTIABLES (this repo)
- **Never `git commit -m "..."` with multi-line text.** Write the message to a file, use
  `git commit -F<file>`.
- **Never modify `.env` or any env var to make something work.** This caused two production
  outages (2026-09-27).
- **Never run `npm run build` on the VPS.** No `lib/` source tree there; grep `.next/server` for a
  marker string instead (`HOW_WE_MOVE_FAST.md` §6).
- **Never print or paste a real secret.** Cloudflare tokens are AES-256-GCM encrypted; only the
  last-4 hint is ever exposed.
- **"Done" ≠ committed ≠ pushed ≠ deployed ≠ proven live.** Prove each separately.
- **Only `gh workflow run deploy.yml --ref main` deploys**, and the deploy job is manual-only —
  a green run can have SKIPPED it. Always check the **job list**, not the run conclusion.
- **Scratch databases only.** Never run a destructive migration against anything you did not
  create this session.
- **Never use a shell heredoc for multi-KB file content** — it corrupts the file through the
  terminal wrapper (this actually happened on 2026-10-05 and needed a `git checkout --` to undo).
  Write content with your editor tool, then `cat smallfile >> target`.

## GATE — all must pass before you commit
```
npx tsc --noEmit              # NOTE: run AFTER a build if you added routes — see trap 2
npx eslint <each file you touched>
npm run test:wallet           # 29
npm run test:support          # 30
npm run test:hosting          # 334
CI=true npm run build
```
**No CI runs these** — your run is the only one. Known pre-existing issues you did NOT cause:
2 ESLint errors in `app/dashboard/billing/page.tsx` (`react-hooks/set-state-in-effect`). Do not fix
them as a drive-by in an unrelated commit.

## THEN
Commit (`-F<file>`) → push → `gh workflow run deploy.yml --ref main` → confirm the **deploy job**
ran and succeeded → check `BUILD_ID` mtime is NEWER than the run start → live-verify with real
curl output → update `SENIOR_HANDOFF.md` §6/§7/§12 per §10 and the relevant task docs.
Code-complete + doc-stale == a broken handoff.

## REPORT BACK
Commit SHAs, deploy run id, live BUILD_ID, the gate output, the live curl results, and — plainly —
anything you could NOT verify. If you did not see a check pass, say it is outstanding.

- **D3 (UI only):** `components/support-widget.tsx`, mounted in `components/shell.tsx` **left of**
  the agent widget, mirroring its footprint/z-index/EXE-suppression. Then the user composer (list
  own tickets → open thread → reply) and the admin queue (list all → thread → reply →
  `open → resolved`). **No new API needed** — it all backs onto existing routes.
- **D4 (needs care):** "send any user a message" **cannot** be built as a new messaging system.
  `SupportMessage` requires a `ticketId` (FK, `onDelete: Cascade`) and `SupportTicket.userId` is
  immutable. The decided route is an **admin-composed ticket**: `createSupportTicket` gains an
  admin `actorId` so an admin opens a ticket on behalf of a chosen user. **The target user id MUST
  come from the admin session, NEVER from the request body** — that is the exact bug the schema
  warns about at `prisma/schema.prisma:3492-3494`. No migration is needed for this route.
