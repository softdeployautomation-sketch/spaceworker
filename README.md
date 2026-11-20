# SpaceWorker

Multi-tenant automation-tools SaaS — lead extraction, filtering, email outreach campaigns, encrypted mailbox credentials, manual crypto payment verification, admin panel, and persistent browser profiles.

## Repo structure

- `task/PLAN.md` — architecture, data model, decisions and why they were made. Read this first.
- `task/` — all task documentation (`TASK_*.md`, `PLAN_*.md`, `BATCH_*.md`, `CLINE_*.md`, `DESIGN_*.md`, `HANDOFF_*.md`, `DISPATCH_*.md`, `EXE_*.md`, `FINAL_*.md`, and all `PROMPT_*.md`/`SENIOR_*.md` playbook docs) — ordered build tasks with clear dependencies and verification steps. **New task files are created under `task/` from the start; never at the repo root.**
- `app/` — Next.js App Router source code (`app/` directory with routes, layouts, server actions).
- `lib/` — shared library modules (`auth.ts`, `admin-auth.ts`, `email.ts`, `db.ts`, `session-user.ts`, `verify-code.ts`, `cn.ts`, `env.ts`).
- `scripts/` — build and deploy scripts.
- `public/` — static assets.
- `.env` — local environment variables (never committed; see `.env.example`).

## Security

Never commit `.env`, encryption keys (`MAILBOX_ENCRYPTION_KEY`), API tokens, SMTP/worker bearer tokens, or playbook docs with secrets (`HOW_WE_MOVE_FAST.md`, `PROMPT_*.md`, `SENIOR_*.md`, `_STEPS.md`) — even temporarily. These are gitignored. If a secret is ever accidentally committed, flag it immediately (git history retains it) rather than just deleting it in a follow-up commit, so it can be rotated.

## Playbook

`HOW_WE_MOVE_FAST.md` is gitignored (contains VPS IPs, SSH keys, and credentials). Read it locally before touching deploy, migrations, or EXE builds.

## Branches

`main` should never get direct pushes — PR + review only. Work happens on dedicated branches.






