# Task 50 — Admin has zero visibility into Mailboxes, Campaigns, or Automations

**Status: ready to build. Found during a security/completeness audit, 2026-09-20.**

## The real gap, confirmed live in code (not assumed)

The admin panel (`app/admin/(protected)/admin-panel.tsx`, `TABS` at lines 55–65) has exactly these tabs: Users, Payments, Wallets, Notifications, Browser Sessions, Search Queue, Services, Campaign Templates, AI, Licenses.

`Campaign Templates` is the admin-authored template library (what customers can pick from) — it is **not** a view of what customers are actually doing. There is no tab for a customer's own `Mailbox` rows, no tab for their `EmailCampaign`/send activity, and no tab for `CampaignAutomation` (the recurring/scheduled automations feature, Task 9/37/38's work).

Confirmed by grep: no file under `app/api/admin/**` queries `prisma.mailbox`, `prisma.campaign`, `prisma.emailCampaign`, `prisma.campaignAutomation`, or `prisma.emailQueueItem` — the admin API surface never touches these tables at all.

Confirmed further by checking every `notifyAdmin()` call site in the codebase: it's only ever called for (1) new signups, (2) EXE license issuance, (3) EXE license bind, (4) EXE license transfer. There is no Telegram/notification hook for a mailbox being connected, a campaign being sent, a campaign hitting a deliverability pause, or an automation run starting/failing.

**Net effect**: a customer can connect arbitrary SMTP mailboxes and send mass email campaigns — real spam/abuse/reputation risk to the platform's own IP and domain if the customer misuses it — and the admin has literally no way to see any of it happening, not in the dashboard, not via alert, short of querying the production database by hand. This is exactly the blind spot the owner has flagged before (see memory: "every backend capability needs admin-facing visibility built in the same pass") and it applies here to the single feature area with the most real-world abuse potential in the product (outbound email).

## The fix

1. Add a **Mailboxes** admin tab: list of all connected mailboxes across all users (host, masked username, active/inactive, daily send count vs. cap, last-tested status) — read-only is fine to start, but it must exist.
2. Add a **Campaigns** admin tab: list of all `EmailCampaign` rows across all users with status (draft/queued/sending/paused_deliverability/done), recipient count, send progress, and which mailboxes/variants it's using.
3. Add an **Automations** admin tab: list of all `CampaignAutomation` rows with status (scheduled/running/paused/done), owning user, and last-run outcome.
4. Add `notifyAdmin()` (or a lighter per-event log visible in the new tabs) for at minimum: a campaign entering `paused_deliverability`, and any campaign send crossing a size threshold worth knowing about (e.g. >100 recipients in one run) — the deliverability-pause case especially, since that's the platform's own reputation at stake, not just the customer's.

## Verification expected

- Create a mailbox + a small campaign as a test user; confirm it's visible in the new admin tabs without touching the database directly.
- Trigger (or simulate) a `paused_deliverability` status change; confirm the admin gets a Telegram notification, same posture as the existing license-event notifications.
