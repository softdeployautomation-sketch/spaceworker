# TASK_174 — Premium / Premium Plus tier split (SCOPED 2026-10-06)

Owner directive (verbal, 2026-10-06): today's single Premium BECOMES
Premium Plus for all current users; a trimmed Premium is the only
advertised tier. Plus is never advertised — owner decides who gets it
(free-tier users may request via support ticket; owner sends a manual
invoice through the existing payment flow; on approve they become Plus).

## 1. How tiers work TODAY (verified this session)

- User.tier: 0 = legacy/license_only, 1 = trial (15 min/day/tool,
  ToolUsageLog, lib/trial.ts), 5 = Premium. 2/3/4 unused. All pro
  branches test `>= 5`.
- Premium engine lib/premium.ts: PREMIUM_TIER=5, 30-day terms via
  premiumExpiresAt, lazy reversion to 1 on read, grandfathered NULL
  expiry never expires. grantPremium() stacks (max-then-add).
- Public gate lib/entitlements.ts hasEntitlement(): tier 5 implicitly
  allows EVERY key (extractor, mailer, assistant, devices, cyberlab,
  hosting). Tier number is storage; hasEntitlement is the decision.
- Exit nodes canUseExitNodes() = premium AND !nodeAccessRestricted.
  Routes tab has per-user Restrict (node-only).
- Queue: dispatch orderBy [{priorityTier desc},{createdAt asc}]
  (dispatch/route.ts:194); jobs stamp priorityTier = tier at creation.
  HIGHER NUMBER RUNS FIRST.
- Billing: web_subscription (kind web) → bumpWebTier → grantPremium 30d.
  Wallet W5 spend writes tier 5. Store sells ONE web bundle.
- Admin: PATCH users/[id]/tier, POST grant-premium (stacks), Devices tab
  per-user machines. Settings badge: "Pro" for tier>=5 else "Free".

## 2. Target design (owner decisions 2026-10-06)

- Tiers: 1 = trial (unchanged), 5 = Premium (trimmed), 10 = Premium Plus
  (everything today + all future device tools). 10 chosen so `>= 5`
  gates stay true for BOTH (zero-risk compat); dispatch 10>5>1 falls
  out free — Plus jumps Premium jumps trial, no dispatch code change.
- Plus content: EVERYTHING tier-5 holders have today, plus all new
  device-console tools. No other trims (owner: keep nothing else).
- Premium keeps: mesh/remote-control viewer ONLY (mesh-urls), PLUS all
  other premium surfaces unchanged (extractor, mailer, assistant,
  cyberlab, hosting, exit nodes, automations, browser profiles).
- Plus-only device tools (403 plus_upgrade_required for tier-5):
  screen monitoring (screenshots/*, monitoring tab), PIN request,
  hide/reveal agent, maintenance overlay, run-command/cmd,
  queued-commands, ping/power/wake/reboot/shutdown, clone-setup,
  discover-apps, launch, activity.
- Plus NEVER advertised: no store card, no pricing entry, no upsell.
  Awarded ONLY via (a) admin grant-plus route, or (b) manual invoice
  payment approved with product premium_plus_invoice → grantPlus
  (stacking, same as grantPremium). Request flow: user asks in a
  support ticket → owner creates Payment → user pays → approve.
- Per-user RESTRICT button on Users tab: new User.accountRestricted
  bool (one small migration). Restricted = no dispatch/mail/browser/
  device use (403 account_restricted), keeps login+settings+support.
  Node restrict stays as-is (subset).
- All current users → Plus: backfill tier-5 rows to tier 10 (NULL
  expiry rows keep NULL = grandfathered Plus). Tier-1 untouched.
  Settings badge becomes Premium / Premium Plus / Free.
- Reversion: 10→5→1 on term pass (Plus lapses to Premium, not trial).

## 3. Build order (sequential)

1. T174a engine: PREMIUM_PLUS_TIER=10, isPlusTier, grantPlus, reversion.
2. T174b device gating: Plus-only routes + console tabs. Tests per route.
3. T174c billing: premium_plus_invoice product + price field + branch.
4. T174d admin: grant-plus route, Restrict button + gate, badge labels.
5. T174e backfill tier-5→10 + dispatch priority test (10>5>1).

## 4. Queue (owner order 2026-10-06)

Grant fix (0c) FIRST → wallet W6 → THIS task (row 0d). Feature agent's
next build is STILL the grant fix — this doc is scope-only, no code.
