// TASK_184 addendum 2 — THE plan names, in one place, client-safe (no
// `server-only`, so server pages and client components import the same strings).
//
// Owner (2026-10-08): tier-3 accounts also read as "Premium" on the web login,
// but they only carry `devices` — so the thing a user REQUESTS when they want the
// whole web app (tier 5) needed its own name. Hence:
//
//   tier 5 (every module key) ......... "Premium Plus"
//   tier 3 (XDevice wrapper term) ..... "Premium XDevice"
//   free / trial (tier 0/1/4) ......... "Free"
//
// Every user-facing tier-5 ask (CTA, plan badge, activation copy, support-ticket
// template, admin invoice) must say Premium Plus; every XDevice surface keeps
// Premium XDevice. Server-side ledger notes and API codes are NOT renamed here —
// TASK_181's tests assert them verbatim (e.g. `Premium — 30 days
// (web_subscription)`), and money records must not be reworded under the UI.
//
// The tier numbers below mirror XDEVICE_TIER / PREMIUM_TIER in lib/premium.ts on
// purpose: that module pulls in the DB and can never be imported by a client
// component, and these two literals are the whole of the mapping.

export const PLAN_PREMIUM_PLUS = "Premium Plus";
export const PLAN_PREMIUM_XDEVICE = "Premium XDevice";
export const PLAN_FREE = "Free";

export type PlanLabel = typeof PLAN_PREMIUM_PLUS | typeof PLAN_PREMIUM_XDEVICE | typeof PLAN_FREE;

/** The label for a tier as the user sees it. Tier 3 is NOT a plain "Premium". */
export function planLabelForTier(tier: number): PlanLabel {
  if (tier >= 5) return PLAN_PREMIUM_PLUS;
  if (tier === 3) return PLAN_PREMIUM_XDEVICE;
  return PLAN_FREE;
}

/** The one button label used wherever the web asks for tier 5. */
export const UPGRADE_TO_PREMIUM_PLUS = "Upgrade to Premium Plus";

/** The support-ticket template label (B2) — same ask, ticket form. */
export const REQUEST_PREMIUM_PLUS_LABEL = "Request for Premium Plus";
