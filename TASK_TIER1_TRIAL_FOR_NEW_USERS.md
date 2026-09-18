# Task — Tier 1 trial for new users (15 min/day per tool, never prioritized over Premium)

**Status: ready to start.** Owner's ask (2026-09-18), triggered by auditing a real just-registered test account (`tossacoin001@gmail.com`) and finding free-tier users currently have **no time cap at all** — unlimited extraction runtime, just lowest queue priority.

## Read this first — a real naming collision in the existing tier system

Today `tier` is a single `Int` on `User` (`prisma/schema.prisma:15`, default 0), and **`tier >= 1` already means "Premium/Pro"** in five places:

1. `app/api/auth/login/route.ts:73` — `tier < 1` → `"license_only"` plan state
2. `app/dashboard/settings/page.tsx:38` — `tier >= 1 ? "Pro" : "Free"`
3. `app/api/browser-profiles/route.ts:56` — `tier < 1` blocks this Pro-only feature
4. `app/api/browser-sessions/route.ts:107` — `tier < 1` blocks this Pro-only feature
5. `lib/license-service.ts:47` (`bumpWebTier`) — sets `tier: 1` when a real web-subscription payment is approved. **This is the actual source of truth that grants Premium today.**

The owner wants the new trial tier called "Tier 1" in the upgrade email. That number is already taken by Premium. **Resolution: renumber Premium to tier 2, and give the new trial tier the number 1** — matching what the email should say, and requiring a one-time migration plus updating all five spots above from `tier < 1`/`tier >= 1` to `tier < 2`/`tier >= 2`, and `bumpWebTier` to set `tier: 2`. Do not skip any of the five — missing one either breaks real paying customers' Pro access or accidentally grants it to trial users.

**Migration, run once before the code change ships**: bump every existing `tier >= 1` user (real, already-paying Premium customers) to `tier = 2` first, so nobody's access silently changes. Do NOT touch existing `tier = 0` users in this migration — see scope note below.

## What already exists and needs zero new code

Checked directly against the dispatcher (`app/api/internal/dispatch/route.ts`):

- **Priority queue already works correctly.** Every job is stamped with `priorityTier: user.tier` at creation (`app/api/jobs/route.ts:262`, `lib/automation-run.ts:280`, `lib/agent-executor.ts:235`), and dispatch orders by `priorityTier desc, createdAt asc` (`app/api/internal/dispatch/route.ts:111`). Once Premium is tier 2 and trial is tier 1, "never prioritized over Premium" is already true — no new code needed here.
- **"Doesn't have to queue when the system is idle" is already true.** Admission is slot-based per lane (`maxConcurrent`, `app/api/internal/dispatch/route.ts:96-107`) — a job only waits behind others competing for the SAME free slot. An idle lane dispatches the next-highest-priority job immediately regardless of its tier. Don't build special-case "idle bypass" logic; it already falls out of the existing admission check.

## What's actually new

1. **Migration**: bump existing Premium users 1→2 (see above).
2. **Update the five `tier < 1`/`tier >= 1` spots** listed above to `< 2`/`>= 2`, and `bumpWebTier` to `tier: 2`.
3. **15-min/day-per-tool quota for tier 1.** Interpretation to confirm with the owner before building: each tool (the BUILD_TARGET variants — extractor, mailer, combined, automation) gets its OWN 900-second daily allowance, not one shared pool. Model this on the exact pattern already proven for `aiDailyCapHundredthsCent` (`schema.prisma:30-35`, enforced via a SUM over today's log rows, referenced from `runAgentTurn`): a new append-only usage-log table (userId, tool, elapsedSeconds, createdAt), summed per user+tool+UTC-day, checked at job admission (reject or truncate at 900s remaining) for `tier === 1` only. Tier 0 (pre-trial-assignment, see below) and tier 2 (Premium) are NOT subject to this cap — Premium never was, and tier 0 shouldn't really exist going forward once every new registrant becomes tier 1 (see next point), but leave tier 0 uncapped rather than inventing a third quota tier, since the owner didn't ask for one.
4. **Auto-upgrade on registration.** Trigger point to confirm: recommend doing this at **email verification**, not raw signup — matches the existing `emailVerified` gate that already governs when an account becomes actually usable (`app/dashboard/layout.tsx:24`). On verification, if `tier === 0`, set `tier = 1`. This is the "flow for every new user" the owner described.
5. **Upgrade email.** Reuse the existing notification fan-out (`lib/notify.ts`, the `notifyEmail`/`notifyTelegram`/`notifyAgent` pattern already on `User`) to send a "You've been upgraded to Tier 1 — try SpaceWorker free, 15 minutes/day per tool" email at the same trigger point as #4.
6. **Existing tier-0 (already-verified, already-registered) users**: leave them alone in this task — the owner said "this will be the flow for every NEW user," not a retroactive backfill. Don't auto-bump or email existing free accounts without a separate, explicit go-ahead.

## Explicitly out of scope

- Any change to how Premium itself is granted/priced.
- A third quota tier, or per-tool differentiation beyond the flat 900s/tool/day rule.
- Backfilling existing tier-0 users.

## Verification required before calling this done

1. Run the migration against a copy/staging first if possible; confirm the count of bumped users matches the real number of paying customers before running against production.
2. Real end-to-end test: a fresh signup verifies email → confirm `tier` becomes 1 and the upgrade email actually sends.
3. Confirm a tier-1 user's job queues behind a tier-2 (Premium) user's job when both are waiting for the same lane slot, and confirm a tier-1 job dispatches immediately when the lane is idle.
4. Confirm a tier-1 user is hard-capped at 900s/day on a given tool (run one job to the cap, confirm a second is rejected/truncated same day, confirm it resets the next UTC day).
5. Confirm none of the five `tier` gating spots were missed — a real Premium account (tier 2) must still see "Pro" in Settings and keep Browser Profiles/Sessions access after the migration.
