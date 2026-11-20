# Task 28 — Harden the CampaignAutomation builder (Task 27 Part B follow-up)

**Status: ready for Cline.** Task 27 Part B's manual `CampaignAutomation` builder shipped and is live (commit `3e29bcd`, deployed via GitHub Actions run `34705563310`, migration `20260912100000_add_campaign_automations` applied to the production DB automatically by the deploy pipeline's `prisma migrate deploy` step). Its own handoff notes (bottom of `TASK_27_EXE_LICENSING_AND_AUTOMATIONS_AGENT_PLAN.md`, "What the next agent should do") listed 5 gaps before it's production-solid. This doc makes each one concrete, grounded in the actual current code (checked 2026-09-12). Do these in order — later items build on earlier ones being done first.

Do not start Part B's AI agent or Part A's EXE/licensing work until this doc is done — the owner explicitly chose to close these gaps first rather than build on top of a half-finished foundation.

---

## 1. Wire the hourly scheduler (systemd timer)

`app/api/internal/automations-sweep/route.ts` already exists and is gated by `INTERNAL_BEARER_TOKEN` (same pattern as every other `/api/internal/*` route), but **nothing calls it** — no systemd unit exists for it today. Confirmed: `deploy/` currently only has `mail-queue-drain.service`/`.timer` (runs every minute) and whatever units back `extraction-worker`/`spaceworker-browser`; there is no `automations-sweep.*`.

Create two new files, copying `deploy/mail-queue-drain.service`/`.timer` exactly except for the target URL and cadence:

- `deploy/automations-sweep.service` — oneshot curl to `http://localhost:3000/api/internal/automations-sweep` with the same `Authorization: Bearer %INTERNAL_BEARER_TOKEN%` header pattern.
- `deploy/automations-sweep.timer` — `OnBootSec=5min`, `OnUnitActiveSec=1h` (hourly — daily automations only need hour-granularity, unlike the mail drain's per-minute cadence).

Add the install step to whichever deploy script/doc currently documents installing `mail-queue-drain.{service,timer}` on the VPS (check `deploy/` for a README or the GitHub Actions deploy job itself — `.github/workflows/deploy.yml`'s deploy step likely already has a systemd-install section to extend) so this ships the same way the mail-queue drain did, not as a manual one-off on the VPS.

## 2. Unify `POST /api/campaigns` onto `lib/campaign-create.ts`

`app/api/campaigns/route.ts`'s `POST` handler currently inlines its own `prisma.$transaction` that creates the `EmailCampaign` + `CampaignVariant` rows + calls `buildQueueItemRows` directly (lines ~195-225 as of this doc). `lib/campaign-create.ts`'s `createCampaign()` was written specifically to be the one shared implementation of this transaction — the automation run's send phase (`lib/automation-run.ts`) already calls it, but the original route was never refactored onto it, so there are now two copies of the same transaction that can silently drift.

Refactor `app/api/campaigns/route.ts`'s `POST` to:
- Keep all of its existing validation and the three-source recipient resolution (CSV / `leadIds` / `searchJobId`) exactly as-is — that logic doesn't belong in `createCampaign()`, which deliberately takes an already-resolved `recipients: RecipientInput[]`.
- Once `recipients` is resolved, call `createCampaign({ userId: session.userId, name, mailboxIds, variants, recipients, rotateEvery, searchJobId })` instead of the inline transaction.
- **Watch the response shape**: the route today returns `{ campaign, recipientCount, rowErrors }` where `campaign` is the full Prisma row. `createCampaign()` returns `{ campaign: { id }, recipientCount, byMailbox }` — a narrower `campaign` (id only) and no `rowErrors` field. Check what the Campaigns page (`app/dashboard/campaigns/page.tsx`) actually reads from the POST response before changing the returned shape — either keep returning the full campaign by doing one extra `findUnique` after `createCampaign()` returns, or confirm the frontend only needs `campaign.id` and adjust it if not. Don't guess; grep the frontend's usage of the POST response first.

## 3. Confirm a real end-to-end delivered send (verification task, not new code)

This is the one item that is **not a coding task for Cline** — it requires an actual mailbox and a human checking a real inbox. Flag it back to the user/owner rather than marking it done from code review alone: create a real campaign (manual, small recipient list — even a single test address), run it through the existing test-send → `POST /api/campaigns/[id]/confirm-test` flow, and confirm an email actually lands in an inbox. Everything downstream (automations' `processSendPhase`, the always-test-send-confirm gate) assumes this path genuinely delivers; per the last mailbox-testing thread the user was mid-troubleshooting a Brevo IP-allowlist issue and never confirmed a real delivered send. Get that confirmation before treating any automation's "done" status as meaning real emails went out.

## 4. Make the daily "needs confirmation" alert real, and fix its misleading log entry

`lib/automation-run.ts`'s `notifyNeedsConfirmation()` (around line 61-70) only writes a `NotificationLog` row — it does not send anything. Two problems to fix together:

- **It's currently misleading, not just incomplete**: the row is written with `outcome: "sent"` and `channel: "email"`, but no email was sent — this looks like a real audit-log bug, not just a missing feature. If the in-app-only notification stays as a fallback, its outcome should read `"logged"` or similar, not falsely claim `"sent"`.
- **Wire a real send** using the already-existing `sendEmail()` from `lib/email.ts` (SpaceWorker's own transactional-email path, same one used for verification codes — separate Resend account from any customer SMTP, confirmed safe to reuse for this internal notification). Look up the automation owner's real email via `automation.userId` → `User.email` (the function currently only receives `automationName`, not the user's email — thread the real recipient through from the caller). Compose a short subject/body: which automation needs confirmation, and a link to `/dashboard/automations/[id]/runs/[runId]`. Keep the existing `NotificationLog` write too (with the corrected, accurate `outcome`) — `sendEmail()` already writes its own log entry internally via `recordNotificationLog`, so check whether you still need the separate manual `prisma.notificationLog.create()` call at all once `sendEmail()` is wired in, or whether that becomes a duplicate to remove.

## 5. Decide the tier-(b) ready-made template model

Not yet built at all — right now `CampaignAutomation.campaignTemplateId` only supports tier (a): cloning a campaign the user already built themselves via the Campaigns tab. Per the plan doc, the implementation choice is open: system/admin-owned `EmailCampaign` rows that get cloned the same way tier (a) does, vs. a dedicated `CampaignTemplate` model. Recommendation: start with the admin-owned-`EmailCampaign` approach — zero new schema, `createCampaign()`/`loadTemplateCampaign()` already work unchanged against any `EmailCampaign` id regardless of who owns it, so this is mostly an admin UI to author a few starter templates plus a query-side change to let the automation builder's template picker list "my campaigns" + "ready-made templates" as two groups. Only reach for a dedicated model if admin-owned campaigns turn out to need fields tier (a) campaigns don't (e.g. a category/description for the picker) — check with the user before adding a new model for that reason alone.

---

## Verification expected before calling this done

- `npx tsc --noEmit` clean, `npm run build` clean (same bar as every prior Task 26/27 piece).
- Item 1: confirm the timer actually fires on the VPS after deploy (`systemctl status automations-sweep.timer`, or wait for a real hourly tick and check the sweep route's logs/a `CampaignAutomationRun` gets created for a due daily automation).
- Item 2: confirm `POST /api/campaigns` still returns whatever the Campaigns page actually needs — test creating a campaign through the UI, not just a curl.
- Item 4: confirm a real email actually arrives when a daily automation hits `needs_confirmation` (this piggybacks on item 3's real-send confirmation once that's unblocked).
- Report back per-item, not just "done" — this doc lists 5 genuinely separate changes; note which are code-complete vs. still needing the owner's live confirmation (items 3 and part of 4).
