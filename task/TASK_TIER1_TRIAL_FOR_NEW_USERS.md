# Task — Tier 1 trial for all free users (15 min/day per tool, never prioritized over Premium)

**Status: ready to start.** Owner's ask (2026-09-18), triggered by auditing a real just-registered test account (`tossacoin001@gmail.com`) and finding free-tier users currently have **no time cap at all** today — unlimited extraction runtime, just lowest queue priority.

## Confirmed decisions (owner, 2026-09-18)

- **Premium becomes tier 5, not tier 2.** Checked `lib/products.ts`: there is exactly ONE web-app pricing product today (`web_subscription`, a single flat price via `webSubscriptionPriceUsd`) — no existing tiers 2–5 with different pricing. Per the owner's own instruction ("if not then tier 5 becomes the premium"), tiers 2, 3, and 4 are deliberately left unused/reserved headroom for future intermediate paid plans, so introducing one later never requires another renumbering. (The EXE desktop-app products — extractor/mailer/combined/automation — are a completely separate purchase system, license-key-based via `ExeLicense`, and don't touch `User.tier` at all; not in scope here.)
- **Trial tier is 1**, exactly as originally planned.
- **Existing free users ARE included this time** — this reverses the previous draft of this task, which scoped them out. Owner explicitly asked: bump every existing `tier === 0` user (verified or not) to `tier = 1` in a one-time backfill, and email all of them the upgrade notice.

## The tier-numbering collision — still applies, now against tier 5

Today `tier` is a single `Int` on `User` (`prisma/schema.prisma:15`, default 0), and **`tier >= 1` currently means "Premium/Pro"** in five places — all five need to move to `>= 5` / `< 5`, not `>= 2`/`< 2`:

1. `app/api/auth/login/route.ts:73` — `tier < 1` → `"license_only"` plan state
2. `app/dashboard/settings/page.tsx:38` — `tier >= 1 ? "Pro" : "Free"`
3. `app/api/browser-profiles/route.ts:56` — `tier < 1` blocks this Pro-only feature
4. `app/api/browser-sessions/route.ts:107` — `tier < 1` blocks this Pro-only feature
5. `lib/license-service.ts:47` (`bumpWebTier`) — sets `tier: 1` when a real web-subscription payment is approved. **This is the actual source of truth that grants Premium today.** Change this to `tier: 5`.

Miss one and either a real paying customer loses Pro access, or a trial user gets it for free — treat this list as exhaustive-until-re-grepped, not just copy-paste-and-done (re-run `grep -rn "\.tier\b"` after the change and confirm every hit was accounted for, since this list was current as of this task being written, not a guarantee nothing else touches tier).

## Migration (run once, before the code ships, in this order)

1. Bump every existing `tier >= 1` user (real, already-paying Premium customers) to `tier = 5` first — so their access never silently changes.
2. Then bump every remaining `tier === 0` user to `tier = 1` — this is the backfill. Record who was bumped (for step 3).
3. Send the upgrade email (see below) to everyone bumped in step 2 — both already-verified and not-yet-verified accounts. Don't skip unverified accounts: the email's own call-to-action is "verify your email" for exactly those users.

After this migration, going forward: **new signups should get `tier = 1` immediately at registration** (change the schema default from `0` to `1`, or set it explicitly in the signup handler) rather than waiting for email verification — simpler than the original plan, and consistent with the backfill applying to unverified accounts too. Verification stays exactly as strict a gate as it is today for actually reaching the dashboard (`app/dashboard/layout.tsx:24`) — this only changes what tier number a not-yet-verified account carries.

## What already exists and needs zero new code

Checked directly against the dispatcher (`app/api/internal/dispatch/route.ts`):

- **Priority queue already works correctly.** Every job is stamped with `priorityTier: user.tier` at creation (`app/api/jobs/route.ts:262`, `lib/automation-run.ts:280`, `lib/agent-executor.ts:235`), and dispatch orders by `priorityTier desc, createdAt asc` (`app/api/internal/dispatch/route.ts:111`). Once Premium is tier 5 and trial is tier 1, "never prioritized over Premium" is already true — no new code needed here.
- **"Doesn't have to queue when the system is idle" is already true.** Admission is slot-based per lane (`maxConcurrent`, `app/api/internal/dispatch/route.ts:96-107`) — a job only waits behind others competing for the SAME free slot. An idle lane dispatches the next-highest-priority job immediately regardless of its tier. Don't build special-case "idle bypass" logic; it already falls out of the existing admission check.

## What's actually new

1. **Migration** — see above (two-phase bump: existing Premium → 5, existing free → 1).
2. **Update the five `tier < 1`/`tier >= 1` spots** listed above to `< 5`/`>= 5`, and `bumpWebTier` to `tier: 5`.
3. **New-signup default becomes tier 1** (schema default or signup-handler change — see migration section).
4. **15-min/day-per-tool quota for tier 1.** Interpretation to confirm with the owner before building: each tool (the BUILD_TARGET variants — extractor, mailer, combined, automation) gets its OWN 900-second daily allowance, not one shared pool. Model this on the exact pattern already proven for `aiDailyCapHundredthsCent` (`schema.prisma:30-35`, enforced via a SUM over today's log rows, referenced from `runAgentTurn`): a new append-only usage-log table (userId, tool, elapsedSeconds, createdAt), summed per user+tool+UTC-day, checked at job admission (reject or truncate at 900s remaining) for `tier === 1` only. Tier 5 (Premium) is exempt, as always.
5. **Upgrade email** — reuse the existing notification fan-out (`lib/notify.ts`, the `notifyEmail` pattern already on `User`). One email template, sent to (a) everyone bumped in the backfill, and (b) every new signup going forward at registration. Suggested copy (adjust freely, this is a starting point not final copy):

   > **Subject: You're on Tier 1 — try SpaceWorker free**
   >
   > You've been upgraded to Tier 1. That gets you 15 minutes a day on every tool, free — no card required.
   >
   > [If not yet verified:] Verify your email to start using it: [verify link]
   >
   > Want unlimited access and top priority in the queue? Upgrade to Premium: [pricing link]

## Explicitly out of scope

- Any change to how Premium itself is granted/priced, or its price point.
- A third quota tier, or per-tool differentiation beyond the flat 900s/tool/day rule.
- Building out tiers 2/3/4 — reserved, not used, not this task.

## Verification required before calling this done

1. Run the migration against a copy/staging first if possible; confirm the count bumped to tier 5 matches the real number of paying customers, and the count bumped to tier 1 matches the real number of existing free accounts, before running against production.
2. Confirm the backfill email actually sent to a real sample of both verified and unverified existing free accounts, with the right conditional copy for each.
3. Real end-to-end test: a fresh signup → confirm `tier` is 1 immediately (before verifying), confirm the welcome/upgrade email sends.
4. Confirm a tier-1 user's job queues behind a tier-5 (Premium) user's job when both are waiting for the same lane slot, and confirm a tier-1 job dispatches immediately when the lane is idle.
5. Confirm a tier-1 user is hard-capped at 900s/day on a given tool (run one job to the cap, confirm a second is rejected/truncated same day, confirm it resets the next UTC day).
6. Confirm none of the five `tier` gating spots were missed — a real Premium account (tier 5) must still see "Pro" in Settings and keep Browser Profiles/Sessions access after the migration.
