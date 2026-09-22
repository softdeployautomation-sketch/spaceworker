# Task 99 — Module store + commerce (C2, C3)

**Status: ready. Depends on TASK_92 (entitlements core).**
**Plan: `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` §COMMERCIAL TRACK, §FINALIZED DECISIONS (pricing defaults).**

## Read first (mandatory)
- **`HOW_WE_MOVE_FAST.md`** §0–§3 (as TASK_92).
- **`lib/products.ts`** — the single source of truth pattern (ProductId, StoreProduct, AdminSettingPriceFields, priceField lookup); **`components/store.tsx`**; **`app/api/billing/`** crypto checkout flow; **`Payment` model**; **Task 55** semantics (`premiumExpiresAt` lazy reversion) that entitlement expiry mirrors.
- **`PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md`** §COMMERCIAL TRACK C1–C3, pricing defaults in §FINALIZED DECISIONS.

## Goal
Users pick what they pay for: extractor alone, extractor+mailer, Cyber Lab alone, etc. Existing crypto rails only — pricing is configuration, not a new build.

## Deliverables
1. **New products in `lib/products.ts`**: `extractor_module`, `mailer_module`, `assistant_module` (assistant+devices), `cyberlab_module` (+ optional bundle rows). Each with its own `AdminSetting` price field (defaults per plan: $19/$19/$29/$29 monthly; tier-5 full bundle unchanged $79.97/mo).
2. **Checkout → entitlement grant**: on payment confirmation, grant `UserEntitlement` (source "module", monthly expiry — lazy reversion semantics identical to Task 55). Bundle = multiple grants in one transaction.
3. **Store UI**: module cards with "pick what you pay for" framing; free tier messaging (tier 1 = see all, run-limited; 24h full-access trial per signup); entitlement state visible in Settings/Billing.
4. **Admin**: grant/revoke any entitlement per user (source "admin_grant"); price fields admin-adjustable at runtime (existing AdminSetting pattern).
5. **Enforcement wiring**: every feature built in Tasks 92–98 checks `hasEntitlement` server-side (real gate) + hides UI. Dark-launch rule: features merged before their module goes on sale stay invisible.

## Non-goals
Store route move + marketing copy (Task 100); standalone EXE yearly license (C4 — deferred).

## Acceptance
- Buy `cyberlab_module` with crypto on the test flow → entitlement granted → feature unlocks without redeploy → expiry passes → lazily locks again (Task 55 semantics verified).
- Admin grant/revoke works; bundle grants all constituent entitlements atomically; `tsc --noEmit` clean; §2 deploy live-verified.
