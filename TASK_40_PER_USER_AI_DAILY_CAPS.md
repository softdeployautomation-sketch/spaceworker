# Task 40 — Per-user AI daily caps, admin-adjustable in real time

**Status: ready for Cline.** Independent of Task 38/39 — pure cost-control plumbing around the existing `channelryAiChat` wrapper (Task 31, live since 2026-09-13). No UI/agent-behavior dependency on either of those tasks.

## The ask, as given (2026-09-13)

> we should give each user daily limit of ai and how we can manage and add more to users in need asap from admin.

## Why this doesn't already exist (confirmed 2026-09-13)

Channelry caps SpaceWorker as a WHOLE client at `$50/day` (`cap_hundredths_cent: 500000`) — that cap is enforced Channelry-side, across every SpaceWorker user combined, with zero per-user breakdown. `lib/channelry-ai.ts`'s `external_user_id` field was built specifically to enable a future per-user breakdown (its own comment: *"this field is what lets SpaceWorker break down ITS OWN daily pool by its own user later if it ever wants to. Never hardcode or omit it"*) — it's already being passed on every call, but nothing on SpaceWorker's side reads it back to enforce anything. Today, one user's heavy agent usage could silently burn through the entire shared $50/day pool and starve everyone else, with no visibility into who used what.

## 1. Track real usage per user (`prisma/schema.prisma`)

New model:

```prisma
model AiUsageLog {
  id                 String   @id @default(cuid())
  userId             String
  user               User     @relation(fields: [userId], references: [id])
  costHundredthsCent Int      // the REAL cost_hundredths_cent Channelry returned for this call
  eventType          String   // e.g. "agent_turn", "admin_test_connection"
  createdAt          DateTime @default(now())

  @@index([userId, createdAt])
}
```

An append-only log (matching this codebase's established preference for auditable rows over mutable counters — `DeliverabilityCheck`, `NotificationLog` are the precedent), not a running counter column — "today's usage" is a `groupBy`/`sum` over rows with `createdAt >= startOfTodayUTC`, which is correct even across concurrent requests (a mutable counter needs a transaction to avoid a race; a log insert doesn't).

`User` gains `aiDailyCapHundredthsCent Int @default(20000)` (a $2/day default — modest against the shared $50 pool; deliberately admin-adjustable per user, not a global constant, per "add more to users in need").

## 2. Enforce it at the one real call site

`lib/agent.ts`'s `runAgentTurn` is currently the only caller of `channelryAiChat` besides the admin test-connection button (which should stay uncapped — it's an admin diagnostic, not user usage, and already goes through session-gated `/admin`). Before calling `channelryAiChat`:

- Sum today's `AiUsageLog` rows for `opts.userId`.
- If `sum >= user.aiDailyCapHundredthsCent`, skip the call entirely and return a clear reply (no tool call, no pending action) telling the user they've hit today's AI limit and it resets at midnight UTC (or whatever reset boundary the codebase's other "today" resets already use — check `Mailbox.sentTodayDate`'s pattern in the mail-queue-drain for the existing "reset at local midnight vs UTC" convention this app already picked, and match it, don't invent a second convention).

After a successful `channelryAiChat` call, insert one `AiUsageLog` row with the REAL `result.usage.cost_hundredths_cent` (never estimate/guess a cost — only log what Channelry actually reported).

## 3. Admin visibility + real-time adjustment

New admin-gated route `app/api/admin/ai-usage/route.ts`:
- `GET` — every user with `email`, today's summed usage, their `aiDailyCapHundredthsCent`, and (fetched once, cached briefly, not per-row) the CURRENT pooled usage/cap from Channelry itself (reuse `channelryAiChat`'s existing `usage` shape via a trivial call, or ask whether Channelry's relay has a usage-only endpoint that doesn't spend anything before building this — if not, a cheap plain-completion "ping" like the existing Test Connection button is an acceptable cost of showing the admin dashboard, since it's admin-only and infrequent).
- `PATCH { userId, aiDailyCapHundredthsCent }` — updates one user's cap immediately (no deploy, no restart — a normal DB write is instantly enforced on that user's next agent turn since item 2 reads it live). Clamp to a sane range (e.g. `[0, 500000]` — can't exceed the whole pool) and reject a negative/NaN value with a 400.

Extend the existing admin panel's **AI** tab (`app/admin/(protected)/admin-panel.tsx`, built in Task 31 item 1) with a per-user table: email, today's usage, cap, and an inline editable cap field (or a few quick-set buttons like "+$1", "+$5", "Unlimited today") that PATCHes immediately — this is the "add more to users in need asap" control. Show the pooled total (sum of all users' today-usage) against the real Channelry $50/day cap at the top of the same tab, so the admin can see headroom before raising anyone's individual cap.

## Explicitly out of scope

- Automatic/dynamic cap adjustment (e.g. auto-raising a power user's cap based on tier) — this pass is manual admin control only, per the literal ask.
- Any change to Channelry's own $50/day pooled cap — that's Channelry-side config (`client_id: spaceworker`), untouched here.
- Billing/plan-based default caps (e.g. tying `aiDailyCapHundredthsCent` to `User.tier`) — worth a future pass, not blocking this one; ship a single flat default now.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean.
- Set a test user's cap very low (e.g. 100 = $0.01), use the agent until it's exceeded, confirm the NEXT agent turn is rejected with a clear message and — critically — confirm via logs/network tab that `channelryAiChat` was never actually called once over-cap (no wasted spend).
- Confirm raising that user's cap via the admin PATCH immediately unblocks their very next turn — no restart, no delay.
- Confirm `AiUsageLog` rows sum to a number that matches what Channelry's own `used_today_hundredths_cent` reports for the whole pool (cross-check SpaceWorker's own per-user total against the ground truth from Channelry, at least once, to catch any unit/rounding mismatch — the field is hundredths-of-a-cent everywhere, don't let a stray divide-by-100 or divide-by-10000 slip in, given this exact class of bug already happened once in Channelry's own cap constant).
