# Task 35 — Live sending ticker, a real-time activity modal, and configurable send pacing

**Status: ready for Cline, after Task 33 lands.** Task 33 is still mid-flight in `app/api/internal/mail-queue-drain/route.ts`, `lib/deliverability.ts`, `app/dashboard/campaigns/[id]/page.tsx`, and the two campaign decision routes — do not start until that's committed, since this task builds directly on the drain loop Task 33 is changing.

## Context: the "stuck" campaign was a real infra bug, now fixed — this is a follow-up UX request, not a bug report

While diagnosing why a campaign sat at "150 queued, 0 sent" indefinitely, we found and fixed a real production bug: all four internal systemd timers (`mail-queue-drain`, `dispatcher`, `payment-verify`, `automations-sweep`) were hitting `localhost:3000`, but the app runs on `:3500` — they'd been silently failing every tick since the Task 28 deploy overwrote a manually-corrected VPS copy with a stale repo template. Fixed directly on production and in the repo's `deploy/*.service` source files (commit `7633187`) so it can't regress on the next deploy. Sends are now flowing correctly.

**The "it's only using one mailbox, no rotation happened" observation was not a bug either** — with `rotateEvery: 10`, the first 10 recipients all correctly go through mailbox A before advancing to mailbox B; at 8 sent, rotation hadn't reached its first boundary yet. Worth confirming this reads clearly to the owner once this task's live ticker ships (seeing sends happen in real time makes this kind of question much less likely to come up again).

Two real, separate asks came out of watching this campaign send:

## 1. A live, always-visible sending ticker — no click required

Today, seeing progress requires opening the "View activity" modal, which is a static snapshot (only updates when re-opened). The owner wants a small, always-visible feed on the campaign detail page itself while `status === "sending"`:

- Shows the **5 most recent send attempts**, newest at the bottom (or top — match whichever reads more naturally with the animation direction below), each as one line: a green check (✓) or red X, the recipient email, nothing else needed on this compact line.
- **Animation**: a new line slides in, existing lines shift up, and the oldest line fades out once it's pushed past the 5th slot — a modern, subtle "ticker" feel (CSS transitions on a keyed list are enough; no animation library needed, matching this codebase's existing `fadeInUp` keyframe convention in `app/globals.css`).
- **Live polling**: while `status === "sending"`, poll a lightweight endpoint (see below) every few seconds for the latest N sent/failed items; stop polling once status leaves `"sending"` (done, paused, stopped).
- Compact by construction — this is explicitly NOT the full activity modal, just a glanceable pulse. No count/percentage needed here; that's what the modal is for.

**New lightweight endpoint** (or extend the existing campaign GET sparingly): `GET /api/campaigns/[id]/recent-sends?limit=5` returning just `{ id, toEmail, status, sentAt }[]` ordered by `sentAt`/`updatedAt` descending — deliberately NOT the full campaign payload (Task 34 already flagged the cost of over-fetching `items` on every action; this ticker polling every few seconds makes that even more important to get right from the start here).

## 2. A genuinely live "View activity" modal

The existing modal (Task 30 item 2) is a one-time snapshot computed from whatever `campaign.items` happened to be loaded when it opened. Make it poll too while the campaign is `"sending"` (same cadence as the ticker, or reuse one shared poll if both are open at once — don't double-fetch): the KPI tallies (recipients/sent/queued/failed), the per-mailbox breakdown, and "most recent sends" should all update live without the user closing and reopening it. Keep the existing modal SIZE as-is (the owner was explicit: no need to make it bigger) — add a scroll region inside the existing "most recent sends" list instead of growing the modal to fit more rows.

## 3. Send pacing: research finding before building a knob

**The owner's ask**: "we should be able to set how many sends per second... most senders send fast, most times I have to set it to go slowly."

**Finding, grounded in how real cold-outreach tooling actually behaves** (this matters before just adding a "faster" knob): for TRANSACTIONAL email (receipts, password resets, notifications) sent through a dedicated, warmed-up, reputable relay (SES, Postmark, a dedicated IP), fast/bulk sending is normal and expected — that's almost certainly the "most senders I've used" reference point. For COLD OUTREACH through personal-style SMTP mailboxes (Gmail, a small business inbox) — which is what this app's mailboxes actually are — the opposite is true: real high-deliverability cold-email tools (Instantly, Smartlead, lemlist, and similar) deliberately throttle to something like 20-50 sends per mailbox **per day**, with randomized delays between individual sends specifically to look human rather than automated. This app's existing `Math.random() * 40_000 + 5_000` (5-45s jitter per send, `app/api/internal/mail-queue-drain/route.ts`) is already following that same convention, not an oversight — sending fast through a personal Gmail account is what gets a domain/account spam-flagged or rate-limited by the receiving provider, it isn't a speed problem to fix.

**What to actually build**: not "make it fast" — make the pace **configurable**, so a user with a mailbox/reputation that can support it (a dedicated relay, a well-warmed domain) can choose to go faster, while the default stays conservative:
- Add `EmailCampaign.minSendDelaySeconds`/`maxSendDelaySeconds` (defaults 5/45, matching today's hardcoded values exactly — zero behavior change for existing campaigns), clamped server-side to a sane floor (e.g., never allow 0-0, which would look like a bot blast) — implementation's call on the exact floor, but don't let a user configure genuinely unsafe pacing without at least a warning in the UI copy.
- Surface this as an advanced/optional field in the campaign create/edit UI, not a prominent dial — most users should never need to touch it.
- **Separately, and likely more impactful for the "it feels slow" complaint**: the drain currently processes mailboxes **sequentially** (`for (const mailbox of mailboxes)`, one mailbox's whole admitted batch finishes before the next mailbox's turn) — for a campaign rotating across 2+ mailboxes, this means mailbox B's recipients wait for ALL of mailbox A's jittered sends to finish first, even though the two mailboxes are independent SMTP connections with independent reputations and there's no real reason to serialize them. Parallelize the mailbox loop (`Promise.all` across mailboxes, keeping the per-item jitter WITHIN each mailbox's own sequential inner loop unchanged) — this alone should noticeably improve perceived throughput for multi-mailbox campaigns without weakening the per-mailbox human-like pacing that actually matters for deliverability.

## Explicitly out of scope

- A true sends-per-second dial with no floor — per the research above, this would actively hurt deliverability for the personal-mailbox case this app is built around; if a genuine transactional/bulk use case shows up later, that's a different campaign type, not a knob on this one.
- Changing the jitter algorithm itself (still `min + random * (max - min)`) — only making its bounds configurable.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Watch a real campaign send with the ticker open — confirm it animates smoothly, shows real sent/failed status per recipient, and stops polling once the campaign leaves "sending".
- Confirm the parallelized mailbox loop doesn't break the batch gate (`dispatchedThisTick` cap is per-campaign, shared across concurrently-running mailbox loops — make sure the cap-check-and-increment is still atomic enough within one Node process tick that two mailboxes can't both admit past the campaign's `batchSize` in the same drain run).
- Confirm a campaign with custom `minSendDelaySeconds`/`maxSendDelaySeconds` actually uses them, and one without falls back to today's 5/45 defaults exactly.
