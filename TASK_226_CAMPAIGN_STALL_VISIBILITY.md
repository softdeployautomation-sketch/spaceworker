# TASK_226 — Campaign Stall Visibility: show WHY sending isn't moving

**Scoped by:** verification agent · **Date:** 2026-10-18 · **Priority:** high (owner-facing confusion, happened live)
**Branch when built:** `agent/task-226-campaign-stall-visibility` off `origin/main` (`c9aa516` or newer)
**Handoff:** `TASK_226_CAMPAIGN_STALL_VISIBILITY_STEPS.md`

## §1 The ask (owner's words)

> "campaign is stalling... no mail is sent since. it just says **sending** with no info of what's delaying it."

The campaign surface gives no reason when sends stop. Owner had to have the agent SSH-query the box to learn anything. Scope: **surface the stall reason + progress truth on the campaign UI.**

## §2 Root cause of TODAY's stall (live incident 2026-10-18 — findings, not scope)

Evidence chain, box-verified:

1. **Sblast1** (`cmvdo5ujp0f0tkpl4i5cqnx3i`) used mailbox `propertyblast` (smtp.zeptomail.com) with **`sendRegion='us'`** → every SMTP connection tunneled through the US SOCKS exit node.
2. **All attempts failed `Greeting never received`** (nodemailer `SMTP_GREETING_TIMEOUT_MS = 10_000`, `lib/mailer-send.ts:77`) — the mail provider never sent the 220 banner to the exit node's egress IP. 100 soft-bounced, **0 sent all day**. Browser HTTPS works fine over exit nodes; SMTP to mail providers from shared/free egress IPs does not.
3. `sendRegion` was then cleared (now **NULL/direct**, re-verified) → **blaast2 immediately sending: 30 sent, 0 errors**.
4. Sblast1 remains **`paused_deliverability`** → the drain gate returns `processed:0` every tick — the campaign looks frozen while parked behind its status. blast3 sits at **`pending_test_confirm`** (normal test-email stage).
5. **UI gap (the actual scope):** `grep -rn 'paused_deliverability' components/` → **zero hits**. No component renders stall states; the drain journal (`journalctl -u mail-queue-drain`) is the only place answers exist.

Operational facts the UI must reflect: drains run **1/min** (systemd timer), **≤50 items/tick**, test-override mode **pauses at each 50-boundary for manual resume**, inter-item delay 1–5 s, soft failures retry at `nextAttemptAt` (backoff — Sblast1's 100 failed items are retry-eligible now).

## §3 Scope (what the task agent builds — READ-ONLY visibility)

1. **Stall banner on `app/dashboard/campaigns/[id]/page.tsx`** (status header + near the "Sending activity" modal, L2366 area): render each status in plain language —
   - `paused_deliverability` → "Paused: waiting for your resume. The queue drains every 60s; nothing sends while paused."
   - `pending_test_confirm` → "Waiting for you to confirm the test email before the full send starts."
   - `sending` + boundary → "Paused at a 50-recipient checkpoint — click resume to continue (by design while test recipients are active)."
2. **Last drain activity strip:** last tick time + `processed/sent/failed` for that tick (source: new lightweight GET on the existing campaigns API reading fresh queue counts + most recent `nextAttemptAt`/`sentAt` activity — **no new table**; if an activity snapshot field already exists on `EmailCampaign`, use it, else derive from `EmailQueueItem` aggregates with an index-safe `LIMIT`).
3. **Failure summary card:** grouped error counts (e.g. "100 × Greeting never received — will retry automatically") + sending mailbox label, host, and **region** ("via US exit node" vs "direct from server") — the exact field that caused today's stall must be visible.
4. **Test-override hint:** when `testRecipientOverride` is active, state that sends pause every 50 for confirmation (so "stalled" reads as "checkpoint").

## §4 MUST NOT touch

- Drain route logic, cadence, batch caps, override modes, retry math — **read-only scope**; no behavior changes.
- No schema change / no migration (`prisma/` protected). No `.env`. No deploy (senior verification agent + owner 🚦).
- Never render recipient lists/`toEmail` in the new UI beyond what the activity modal already shows.
- Don't auto-resume anything — visibility only (auto-continue is an owner product decision, §5).

## §5 Owner decisions (flag, don't build)

1. **Exit-node SMTP policy:** should `sendRegion` be forbidden/warned for SMTP send paths (browser-region ≠ mail-egress)? One-field product rule.
2. **Auto-continue:** replace per-boundary manual resume with an opt-in "keep sending" toggle?
3. **Sblast1 recovery:** it's still `paused_deliverability` — resume whenever wanted; its 100 failed items retry automatically now that the route is direct. blast3 needs its test-email confirmation.

## §6 Gates & tests

- `npx tsc --noEmit` exit 0 · eslint touched files · full `npm test` (floor: 1677 tests / 1676 pass / 0 fail / 1 skip) · `CI=true npm run build`.
- New tests: status→message mapping (all 4 statuses), region label rendering (direct vs `us`), failure-group rendering, and **no-PII assertion** (no `toEmail` in the new payload).
- STEPS doc with evidence + `HANDOFF → VERIFICATION AGENT` section.
