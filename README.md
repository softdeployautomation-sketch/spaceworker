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
| **4** | Mailboxes & Campaigns | Michael | 🔄 In Review | Task 1 |
| **5** | Billing & Admin | Michael | ⏳ Pending | Task 1 |
| **6** | Browser Profiles (Phase 1) | Michael | ⏳ Pending | Task 1 |

### Task Descriptions

- **Task 1** (Scaffold & Auth): User/auth models, session management, admin scaffold. → Pushed to `main`.
- **Task 2** (Extraction Worker): Python worker adaptation (remove DB writes, per-job isolation, DuckDuckGo lightweight test).
- **Task 3** (Queue & Lanes): SearchJob model, dispatcher, priority tiers, two-lane concurrency (light/heavy).
- **Task 4** (Mailboxes & Campaigns): AES-256-GCM encrypted SMTP credentials, multi-run campaigns, per-mailbox daily caps, systemd drain timer.
- **Task 5** (Billing & Admin): Manual crypto payments (BTC/USDT-TRC20), admin panel (users/payments/wallets tabs), ±5% tolerance verification.
- **Task 6** (Browser Profiles Phase 1): Per-user persistent Chrome profiles on shared hardware. Profiles persist across jobs (same user shares sessions/cookies); Phase 1.5 (post-funding) upgrades to per-VM isolation + IPs.

### Ready to Start

- **Michael**: Task 4 is ready for review (mailboxes fully scoped). Once reviewed, move to Task 5 (billing, ports Vantra's live crypto-verify code). Task 6 (browser profiles) can start in parallel — no queue/extraction dependency.
- **Cline**: Continue Task 2 (extraction worker) per existing scope. Task 3 queued after Task 2 finishes.

## Branches

`main` should never get direct pushes — PR + review only. **Note**: GitHub's branch-protection rules require a paid plan on a private repo, so this isn't technically enforced by the platform right now, just by process discipline. Work happens on dedicated branches:
- `michael-dev` — Michael's general-purpose branch, for any task assigned to him (currently Task 4, Mailboxes + Email Campaigns; not tied to just that one task going forward).

## Security

Never commit `.env`, encryption keys (`MAILBOX_ENCRYPTION_KEY`), API tokens, or SMTP/worker bearer tokens — even temporarily. If a secret is ever accidentally committed, flag it immediately (git history retains it) rather than just deleting it in a follow-up commit, so it can be rotated.
