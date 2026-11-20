# Task 43 — Let buyers purchase AI credits, on top of the daily cap

**Status: ready for Cline, queued behind Task 45 (in progress) and Task 27 Part B's new `/api/exe-agent/chat` proxy endpoint** (see that doc's "The Automation-enabled EXE's agent connection..." section, added 2026-09-14 — the desktop app's agent calls must go through that server-side proxy, never call Channelry or spend the credit balance directly from local code). Backend + a bare-bones purchase flow only — the owner explicitly said this doesn't need UI polish on the store cards themselves. **This must cover both the web subscription AND the desktop automation-enabled EXE** — see section 5 below, split into 5a (web) and 5b (desktop, license-key-authenticated, no login).

## The ask, as given (2026-09-14)

> we need to edit the automation enabled part to add that they can also buy ai tokens from us to make the agent work, this doesn't have to be edited on the ui, just on the app so after they buy, we should provide an easy flow for them to buy tokens with the same flow, so we will have a easy connection to our ai and we give them a certain amount per what they buy.

Trigger: the **Automation-enabled EXE** ($100, "Combined plus the AI agent") is the tier that ships the AI agent inside a locally-running copy of this codebase (per Task 27 Part A's architecture — the EXE runs THIS Next.js app locally, not a separate rewrite). That means its agent hits the exact same `runAgentTurn` → `channelryAiChat` path the web app already uses, and is subject to the exact same Task 40 per-user daily cap (`User.aiDailyCapHundredthsCent`, default $2/day, resets at UTC midnight). A buyer who wants to use the agent more than the daily allowance today has no way to get more — this task adds one: **buy a top-up credit balance that funds usage beyond the daily cap**, through the same BTC/USDT checkout already built.

## 1. A purchased balance, separate from the daily allowance — don't conflate them

New field:
```prisma
model User {
  ...
  aiCreditBalanceHundredthsCent Int @default(0) // purchased, non-expiring, spent as an overflow past the daily cap
}
```
This is deliberately a SEPARATE concept from `aiDailyCapHundredthsCent` (an admin-set daily allowance that resets) — a purchased balance never resets on its own, only depletes as it's spent, and tops up again on a new purchase.

## 2. Sell it through the exact same product/checkout system Task 42 already built

Add fixed packs to `lib/products.ts` (same shape as the EXE tiers — id/name/tagline/priceField/kind), e.g.:
```
ai_credits_small  — $5  → $3.50 of usage  (70% pass-through)
ai_credits_medium — $15 → $12 of usage    (80% pass-through — better rate at volume)
ai_credits_large  — $40 → $35 of usage    (87.5% pass-through — best rate)
```
These are STARTING numbers, not a business decision already made (unlike the EXE prices, which the owner gave directly) — surface them as admin-adjustable `AdminSetting` fields exactly like every other price in this app (`aiCreditsSmallUsdCents`/`...UsdToUsageRatio` or equivalent — Cline's call on the cleanest shape, but it must be admin-tunable at runtime, not hardcoded, matching this codebase's own established discipline for every other price). Extend `Payment.product` with the three new ids. `kind: "credits"` (a new `ProductKind` alongside `"web"`/`"exe"`) so `lib/license-service.ts`'s `handleApprovedPayment` can branch correctly — no `ExeLicense` row for this product, no email disclosure requirement like the EXE term secrecy; a credit purchase can be fully transparent (the exchange rate IS the offer, nothing to hide pre- or post-purchase).

## 3. Wire the purchase into the balance

`handleApprovedPayment` (`lib/license-service.ts`) gains a third branch: `kind === "credits"` → resolve the `userId` to credit, then `db.user.update({ data: { aiCreditBalanceHundredthsCent: { increment: usageCentsForThisPack } } })`. **Resolving the `userId` has two paths** (see section 5 for where each originates): a purchase from the logged-in web dashboard (5a) already has `Payment.userId` set the normal way; a purchase from the public `/buy-credits?license=...` page (5b, no session) instead carries the originating `licenseKey` on the payment — resolve it via `ExeLicense.licenseKey → userId` at approval time and credit THAT user. Either way it's the same `User.aiCreditBalanceHundredthsCent` field being incremented. Idempotency matters here just as much as it does for `ExeLicense` (a retried webhook/approval must never double-credit) — reuse the same guard pattern (check whether this specific `Payment.id` has already been applied before incrementing; the existing `ExeLicense.paymentId` unique constraint gave that for free, so either add an equivalent `AiCreditPurchase` audit row with a unique `paymentId` (recommended — also gives a real purchase history, matching this app's general preference for auditable rows over bare counters) or another idempotency guard Cline is confident is airtight against a double-fire).

## 4. Spend from the balance once the daily allowance is exhausted

`lib/agent.ts`'s `runAgentTurn` (around the Task 40 cap-check block, `usedToday >= cap`) currently blocks outright at that point. Change it to: if `usedToday >= cap`, check `user.aiCreditBalanceHundredthsCent > 0` — if there's a balance, let the call through instead of blocking, and remember (a local boolean for this turn) that this specific call is being funded by credits, not the daily allowance. After the real cost comes back from `channelryAiChat` and gets logged to `AiUsageLog` exactly as today, ALSO decrement `aiCreditBalanceHundredthsCent` by that same real cost when the turn was credit-funded (clamp at 0 — never go negative even if the real cost narrowly exceeds the remaining balance; that's an acceptable, tiny, self-correcting rounding edge, not worth blocking a completed call over). If both the daily allowance is exhausted AND the credit balance is 0 (or insufficient — Cline's call whether to require the FULL call cost available upfront, which isn't knowable before the call runs, so "let it through if balance > 0, allow it to go slightly negative-then-clamped in the rare case" is the pragmatic answer, not a hard pre-check), THEN block with a message distinguishing the two cases — "you're out of both your daily allowance and your purchased credits" vs. today's plain "hit today's limit," so the blocked reply can point them at buying more.

## 5. The "easy flow" to buy more — this is TWO flows, not one (updated 2026-09-14)

**This has to work for both buyers of the web subscription AND buyers of the $100 automation-enabled EXE** — the owner's own words: "so users who buy the desktop app gets a easy access to buy credit from us for the agent." The desktop app has no web login of its own (and per Task 45, an EXE buyer's session must NOT get free access to the full web dashboard anyway), so the EXE needs its own path to the exact same purchase — it cannot just link to `/dashboard/automations` and assume a logged-in session.

**5a. Web dashboard flow** (session-authenticated, as originally scoped): a bare-bones section — the owner explicitly said this doesn't need design polish. Add it to `/dashboard/licenses` (already "your purchases" — rename the page's heading/copy to cover credits too if that reads better, Cline's call) or a small new section on `/dashboard/automations` near the agent chat (arguably more discoverable). Reuse `components/store.tsx`'s existing checkout modal for the three new pack products rather than building a second checkout UI. Show the current `aiCreditBalanceHundredthsCent` balance somewhere visible near wherever the buy action lives.

**5b. Desktop EXE flow** (license-key-authenticated, no login): the automation-enabled EXE's local build has no session and — correctly, per Task 45 — must not be handed one just to unlock this. So the agent panel's "Buy more credits" button doesn't try to render checkout inline; it opens the buyer's **default system browser** (not an embedded webview) to a new, deliberately public, no-login page: `https://spaceworker.instaweb.top/buy-credits?license=<key>&email=<email>`, pre-filled from the EXE's own locally-stored activation (`lib/license-state.ts`'s saved activation — editable on the page in case they want to buy for a different license).
- This page is intentionally **outside** Task 45's session-scoping — it needs no dashboard access at all, only the license key in the URL, so it stays reachable even for a buyer whose session (if they have one) is locked to `license_only` scope.
- It reuses the exact same store checkout modal and BTC/USDT/hash-optional payment pipeline as 5a (Task 42/44) — same UI component, same admin-review queue, nothing new to build there.
- The one real difference: `handleApprovedPayment`'s new `kind === "credits"` branch (section 3 below) needs to resolve **which `userId` to credit** two different ways depending on where the purchase came from — a logged-in session's own user (5a), or a `licenseKey` carried on the payment record back to `ExeLicense.licenseKey → userId` (5b, no session exists to read a user from). Carry the originating `licenseKey` on the `Payment` row when the checkout was reached via `/buy-credits` (a nullable column, or reuse an existing free-text field — Cline's call on the cleanest shape) so `handleApprovedPayment` can do that lookup at approval time.
- Balance is the **same** `User.aiCreditBalanceHundredthsCent` field either way — a buyer with both a web account and the desktop app sees one unified balance, spendable from either surface, because both ultimately resolve to the same `User` row (the EXE via `ExeLicense.userId`, per the new `/api/exe-agent/chat` proxy in Task 27 Part B).
- No webhook needed back into the running EXE — after paying, the buyer just sees the higher balance the next time the desktop agent panel checks status (a manual "Refresh balance" action, or on next launch, is enough; this doesn't need to be real-time).

## 6. Admin visibility

Extend Task 40's `/api/admin/ai-usage` (or its admin-panel `AiTab`) to also show each user's purchased credit balance alongside their daily usage/cap — the admin should be able to see both numbers together to understand a user's real total headroom.

## Explicitly out of scope

- Refunds for unused purchased credits.
- Credits expiring — they're a non-expiring purchased balance for this pass; revisit only if asked.
- Any UI redesign of the store cards themselves (explicitly declined by the owner for this task).

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean; migration applied.
- Live: drain a test user's daily cap to zero (same technique as Task 40's own verification), confirm the agent now blocks with the "out of both" message: purchase a credits pack, approve it, confirm the very next agent turn goes through — funded by credits, not the daily allowance — and confirm `aiCreditBalanceHundredthsCent` decrements by the real reported cost afterward.
- Confirm a retried/duplicate approval of the same credits payment never double-credits the balance.
