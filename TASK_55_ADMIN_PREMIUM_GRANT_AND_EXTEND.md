# Task 55 — Admin can grant free users time-limited premium, and extend an existing premium user's expiry

**Status: ready to build. Owner-requested 2026-09-21, part of Batch 3.**

## What's requested

Owner's exact framing: "grant a free user premium access for a certain period, and that user should be treated like the normal premium access for both platforms, and also I should be able to give premium users more time like extend there expiry date."

Two admin actions that are really the same operation:
1. **Grant** — a free/trial user gets premium for N days.
2. **Extend** — an already-premium user's expiry gets pushed further out.

The granted access must be indistinguishable from real paid premium everywhere in the app — no separate "comp" code path, no special-cased feature gate.

## Don't design this from scratch — port Vantra's already-working version

Vantra (`/Users/mikeolab/vantra`) already has this exact feature, fully built and proven, just missing the admin UI (see `TASK_48_ADMIN_GRANT_PREMIUM_UI.md` in that repo). Use it as the reference implementation, not a fresh design:

- **`lib/premium.ts`**: `extendPremium(organizationId, tx?)` — extends by a fixed `PREMIUM_DAYS_PER_CHARGE = 30` days from `max(now, currentExpiry)` (so extending before expiry stacks rather than resets), sets `plan: "premium"`, returns the new expiry. ONE function used by the real payment-confirm path, the customer's own Activate/Renew flow, AND the admin grant route — a fresh grant and an extension are literally the same call.
- **`app/api/admin/organizations/[orgId]/grant-premium/route.ts`**: `requireAdminSession()`-gated, calls `extendPremium(orgId)`, returns the new expiry. Grant-only, no revoke — premium lapses naturally via the expiry, matching "why build an unrevoke path when the expiry already does that."
- **`lib/session-user.ts:108-116`**: the enforcement side — check-on-read reversion. On every load of the user/org, if `plan === "premium"` and `premiumExpiresAt` has passed, flip `plan` back to `"free"` right there (no cron needed — "Ensure the user has an org to operate on" style lazy correction). This is what makes an expired grant actually stop working instead of silently continuing.

## Porting to SpaceWorker — what's different here

SpaceWorker has **no existing time-limited premium concept at all**. `User.tier` (`prisma/schema.prisma`) is set to `5` permanently by `bumpWebTier()` (`lib/license-service.ts`) on a successful web-subscription payment — there's no expiry field, no reversion logic, nothing. This is the gap to close, modeled on Vantra's proven shape:

1. **Schema**: add `User.premiumExpiresAt DateTime?`.
   - **Critical semantic difference from Vantra — read carefully.** In Vantra, `premiumExpiresAt: null` means "not premium" (the field is meaningless on a free org). In SpaceWorker, there are almost certainly ALREADY real `tier: 5` users from before this feature existed, with no way to know their real term. For THEM, `premiumExpiresAt: null` must mean **"grandfathered, never expires"** — the opposite implication. Every NEW premium grant (admin comp or a fresh real payment, once this ships) always gets a real, non-null `premiumExpiresAt`. The check-on-read reversion logic (`if tier === 5 && premiumExpiresAt !== null && premiumExpiresAt <= now`) naturally handles this correctly as long as you never backfill a fake `premiumExpiresAt` onto existing rows — leave them `null` and they're simply never touched by the reversion check. Get this backwards and you'll either silently downgrade every existing paying customer at deploy time, or silently make new grants never expire.
2. **`lib/premium.ts`** (new, mirrors Vantra's file almost verbatim): `extendPremium(userId): Promise<Date>` — SpaceWorker's premium is per-`User` (tier lives on User, not an org-like entity), so this is simpler than Vantra's org-resolution step. Same `PREMIUM_DAYS_PER_CHARGE = 30`, `max(now, current expiry)` stacking, sets `tier: 5` + the new `premiumExpiresAt`.
3. **`bumpWebTier()`** (`lib/license-service.ts`) — decide whether a REAL payment now also calls `extendPremium` (making the web subscription genuinely time-limited, matching how the store page already markets it as "$79.97 / month" — a recurring framing the backend currently doesn't honor at all) or stays permanent and only admin GRANTS expire. Recommended: call `extendPremium` here too, for consistency with Vantra's proven "all premium expires, extension is normal" model and with the store's own existing monthly-price copy — but this is a real behavior change for future paying customers (not existing ones, since those stay `null`/grandfathered per point 1), so confirm with the owner before shipping it rather than assuming.
4. **New admin route + UI**: `app/api/admin/users/[userId]/grant-premium/route.ts` (or similar — match this repo's existing admin route conventions) calling `extendPremium(userId)`, plus a button on the admin Users tab (`app/admin/(protected)/admin-panel.tsx`) next to each user showing their current tier/expiry, with a "Grant/Extend 30 days" action. Show the resulting expiry date in the response so the admin gets immediate confirmation.
5. **Check-on-read reversion**: find SpaceWorker's equivalent of Vantra's `session-user.ts` load path (likely `lib/session-user.ts` or wherever `getCurrentUser()`/session resolution reads `tier` today) and add the same lazy-reversion check.

## Verification expected

- `npx tsc --noEmit -p .` clean; migration applied via the playbook (`HOW_WE_MOVE_FAST.md` §3).
- Live E2E (disposable test user, per the playbook): create a `tier: 1` test user, admin-grant premium, confirm `tier === 5` and `premiumExpiresAt` ~30 days out; call grant again immediately, confirm it STACKS (new expiry ~60 days out, not reset to 30); manually backdate `premiumExpiresAt` to the past on the test user, confirm the next session/gate read flips them back to `tier: 1` (or whatever "not premium" state this repo uses) without any manual intervention.
- Confirm an EXISTING (pre-this-task) real `tier: 5` user with `premiumExpiresAt: null` is untouched by the reversion check — still `tier: 5` after a session read, exactly as before.
- If `bumpWebTier` is also wired to `extendPremium` (point 3): confirm a real test payment now sets a real expiry, and note this explicitly in the final report so the owner knows the behavior changed for future purchases.
