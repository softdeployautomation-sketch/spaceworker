# SpaceWorker

Multi-tenant automation-tools SaaS — lead extraction, filtering, and email outreach today; more tools (with user-defined chaining) later. See `PLAN.md` for full architecture and product context.

## Repo structure (as it fills in)

- `PLAN.md` — architecture, data model, decisions and why they were made. Read this first.
- `TASK_01_SCAFFOLD_AND_AUTH.md` through `TASK_05_BILLING_AND_ADMIN.md` — ordered build tasks. Tasks 1→2→3 and 1→5 are sequential; Task 4 (Mailboxes + Campaigns) only depends on Task 1 and can be built in parallel.

## Branches

`main` should never get direct pushes — PR + review only. **Note**: GitHub's branch-protection rules require a paid plan on a private repo, so this isn't technically enforced by the platform right now, just by process discipline. Work happens on dedicated branches:
- `michael-dev` — Michael's general-purpose branch, for any task assigned to him (currently Task 4, Mailboxes + Email Campaigns; not tied to just that one task going forward).

## Security

Never commit `.env`, encryption keys (`MAILBOX_ENCRYPTION_KEY`), API tokens, or SMTP/worker bearer tokens — even temporarily. If a secret is ever accidentally committed, flag it immediately (git history retains it) rather than just deleting it in a follow-up commit, so it can be rotated.
