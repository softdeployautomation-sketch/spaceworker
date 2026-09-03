# SpaceWorker

Multi-tenant automation-tools SaaS — lead extraction, filtering, and email outreach today; more tools (with user-defined chaining) later. See `PLAN.md` for full architecture and product context.

## Repo structure (as it fills in)

- `PLAN.md` — architecture, data model, decisions and why they were made. Read this first.
- Task documentation (`TASK_*.md` files) — ordered build tasks with clear dependencies and verification steps.

## Task Status & Assignment

| Task | Name | Assigned To | Status | Dependencies |
|------|------|-------------|--------|--------------|
| **1** | Scaffold & Auth | Cline | ✅ Done (main) | — |
| **2** | Extraction Worker | Cline | ⏳ In Progress | Task 1 |
| **3** | Queue & Lanes | Cline | ⏳ Queued | Task 2 |
| **4** | Mailboxes & Campaigns | Michael | ✅ Merged + deployed | Task 1 |
| **5** | Billing & Admin | Michael | ✅ Merged + deployed | Task 1 |
| **6** | Browser Profiles (Phase 1) | Michael | ✅ Merged + deployed | Task 1 |

### Task Descriptions

- **Task 1** (Scaffold & Auth): User/auth models, session management, admin scaffold. → Pushed to `main`.
- **Task 2** (Extraction Worker): Python worker adaptation (remove DB writes, per-job isolation, DuckDuckGo lightweight test).
- **Task 3** (Queue & Lanes): SearchJob model, dispatcher, priority tiers, two-lane concurrency (light/heavy).
- **Task 4** (Mailboxes & Campaigns): AES-256-GCM encrypted SMTP credentials, multi-run campaigns, per-mailbox daily caps, systemd drain timer.
- **Task 5** (Billing & Admin): Manual crypto payments (BTC/USDT-TRC20), admin panel (users/payments/wallets tabs), ±5% tolerance verification.
- **Task 6** (Browser Profiles Phase 1): Per-user persistent Chrome profiles on shared hardware. Profiles persist across jobs (same user shares sessions/cookies); Phase 1.5 (post-funding) upgrades to per-VM isolation + IPs.

### Live deployment

**https://spaceworker.instaweb.top** — Tasks 4/5/6 are merged to `main` and deployed. Runs on the same Contabo VPS as Vantra (`164.68.105.96`, separate systemd service `spaceworker.service` on port 3500, separate Postgres database `spaceworker` with its own dedicated role, own `/opt/spaceworker` deploy path — zero shared state with Vantra).

### ⚠️ Post-merge structural fix — read before starting Task 2/3

Michael's three PRs (Tasks 4/5/6) were each built as **standalone Next.js projects** and landed in their GitHub PRs nested inside the existing `app/` App Router root as `app/app/*` — Next.js was interpreting that literally as route `/app/*`, not as the app root, so the merged build did not compile at all. This has been fixed (commit `ff32492`): all genuinely-new feature routes (billing, browser-profiles, campaigns, mailboxes, admin payments/wallets/users) were moved up to their correct locations under `app/`; Michael's duplicate auth/layout/dashboard-stub scaffolding was discarded in favor of Task 1's already-integrated versions (shared `components/`, design tokens), except his real `dashboard/page.tsx` and `admin/page.tsx` (Task 1's were placeholder stubs — Michael's link to the actual features).

Also fixed as part of the same pass:
- Michael's PR carried its own, more complete Prisma schema (`Mailbox`, `EmailCampaign`, `Payment`, `PaymentVerificationAttempt`, `BrowserProfile` models) that had never actually been applied — only Task 1's bare schema (`User`/`VerificationCode`/`RateLimitEvent`/`AdminSetting`) had a migration. Adopted Michael's complete schema + migration history as the source of truth; both the local dev DB and the production DB were reset to match (no real signups existed yet, so nothing was lost — confirmed Vantra's separate DB/site on the same VPS was untouched throughout).
- An unrelated `package.json` in the parent home directory (`~/package.json`) was confusing Turbopack's workspace-root inference, causing a genuine build failure (`Module not found: Can't resolve '/ROOT/...'`) — fixed via explicit `turbopack.root` in `next.config.ts`.
- `lib/*.ts` files had been inconsistently hand-merged between Task 1's and Michael's versions in an earlier pass of this fix — now restored wholesale to Task 1's original, internally-consistent versions (`auth.ts`, `admin-auth.ts`, `email.ts`, `db.ts`, `session-user.ts`, `verify-code.ts`, `cn.ts`, `env.ts`). Michael's `lib/session.ts` (used by the mailbox/campaign routes) is kept as a thin adapter over `lib/auth.ts`'s `getSession()`.
- Added `nodemailer` dependency (used by mailbox connection-testing) and three new required env vars the merged routes depend on: `BROWSER_PROFILE_BASE_DIR`, `MAILBOX_ENCRYPTION_KEY`, `INTERNAL_BEARER_TOKEN` (see `.env.example`).

Build compiles cleanly end-to-end (39 routes) and has been smoke-tested live (homepage, `/signup`, `/admin/login`, `/dashboard` redirect all return correct status codes at the production URL).

### Not yet tested end-to-end (handed to Cline to verify)

The structural fix above got the merged code **compiling and deploying**, but the actual feature flows from Tasks 4/5/6 have only been smoke-tested at the HTTP-status level, not exercised end-to-end against real data:
- Signup → verify → login → dashboard (Task 1, should already work, but re-confirm post-merge)
- Add a mailbox, test its SMTP connection, confirm encrypted fields never appear in API responses (Task 4)
- Create a campaign, queue sends, manually trigger `/api/internal/mail-queue-drain`, confirm daily caps + jitter (Task 4)
- Submit a manual BTC/USDT-TRC20 payment hash, confirm auto-approve/flag/reject branching (Task 5)
- Admin panel: login, users tab, payments review queue, wallet address config (Task 5)
- Create/list/delete a browser profile via the dashboard UI (Task 6) — note `BROWSER_PROFILE_BASE_DIR` is currently `/opt/spaceworker/browser-profiles` in production, a plain directory on the same shared host (Phase 1 as scoped, not Phase 1.5 isolation)
- Tenant isolation spot-checks across all of the above (one user should never see another's mailboxes/campaigns/payments/profiles)

### Ready to Start

- **Cline**: Please pick up from here — verify the flows listed above against the live deployment (or local dev via `npm run dev`), and continue Task 2 (extraction worker) per existing scope once satisfied Tasks 4-6 are solid. Task 3 queued after Task 2 finishes.
- **Michael**: No action needed right now — Tasks 4/5/6 are merged and deployed. Will get a new task once Cline's verification pass surfaces anything that needs fixing, or once Task 2/3 unlock further work.

## Branches

`main` should never get direct pushes — PR + review only. **Note**: GitHub's branch-protection rules require a paid plan on a private repo, so this isn't technically enforced by the platform right now, just by process discipline. Work happens on dedicated branches:
- `michael-dev` — Michael's general-purpose branch, for any task assigned to him (currently Task 4, Mailboxes + Email Campaigns; not tied to just that one task going forward).

## Security

Never commit `.env`, encryption keys (`MAILBOX_ENCRYPTION_KEY`), API tokens, or SMTP/worker bearer tokens — even temporarily. If a secret is ever accidentally committed, flag it immediately (git history retains it) rather than just deleting it in a follow-up commit, so it can be rotated.
