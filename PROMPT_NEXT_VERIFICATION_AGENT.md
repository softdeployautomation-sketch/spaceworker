# PROMPT — NEXT VERIFICATION AGENT (verify TASK_184: web free-tier locks + ticket premium)

TASK_184 implementation is expected to be COMPLETE when you run. Your job: independently
verify it and close it out — or FAIL it loudly with repro steps. Sources of truth:
**`TASK_184_WEB_FREE_TIER_LOCKS_TICKET_PREMIUM.md`** (scope, exact fixes, Phases A/B/C)
and the implementer's **`TASK_184_STEPS.md`** (their tracker — it MUST exist with every
step checked + evidence; missing/incomplete = FAIL and report). Playbook (binding):
`HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy → §4/§6 live evidence). NEVER git stash;
never edit `.env`; never touch TASK_133; REJECT any commit/doc containing live secrets
(placeholders only); money/invoice work must be in commits separate from UI.

Start: `git log --oneline -8` in `/Users/mikeolab/spaceworker`. The floor commit is
`8fec0ac` (TASK_184 A2 — module gate on 19 write routes); everything else must be AFTER
it. Record `git rev-parse HEAD` and confirm the box BUILD_ID is newer than the TASK_184
commits (playbook §2/§3).

## 1. PHASE A — free users can BROWSE every tab but ACT nowhere
- Run the new suite (`test:module-gate` or whatever package.json names it — mirrors
  `tests/xdevice-route-gate.test.ts`): free session → 403 `extractor_required` on POST
  `/api/jobs` + PATCH extract-region, 403 `hosting_required` on a `[id]` mutation, 403
  `cyberlab_required` on consent; GET reads never gated; **entitled fake passes**;
  **tier-3 positive control** (403 there, devices still allowed); static lock that all
  19 A2 routes contain `moduleToolsDenied(`.
- Live, with a FREE session (playbook §4 harness pattern — DELETE it from the box after):
  the same 403s by curl, GET `/api/jobs` NOT 403, device action → 403 `xdevice_required`.
- UI: `/dashboard/extract`, hosting, cyberlabs render the lock card (feature bullets +
  "Upgrade to Premium") while pages stay browsable; client chunk greps the card.

## 2. PHASE C — tier 3 = devices ONLY on web; wrapper untouched
- Live with a TIER-3 account (live term): every A2 route → same 403 `*_required` as free;
  a devices action route → NOT 403 (the over-lock proof); `grep -E "tier >=|tier >" app/api`
  → no tier-number may decide module access.
- Wrapper regression: `test:wrapper-cookie` (6/6) + client chunk STILL greps the wrapper
  price/Subscribe (`xdevicePrice` render) — the wrapper is the ONLY priced surface; if the
  price card vanished from the wrapper branch = FAIL (owner tested this flow working).

## 3. PHASE B — no prices on web, ticket request, invoice lifecycle
- Static + rendered checks: web billing and settings premium copy show NO subscription
  amount (only the wrapper branch renders an amount — grep both branches); "Upgrade to
  Premium" on web opens the support form with template dropdown defaulting to
  **"Request for Premium"** (`category:"premium_request"` — schema change NOT expected
  (`SupportTicket.category` already exists); flag ANY new migration as a review item).
- e2e with a test account: submit request → flagged in admin support inbox → admin
  "Send invoice" (amount + our payment methods) → invoice visible ONLY to that user →
  user submits payment via existing `/api/billing/submit|topup` → admin approval →
  invoice `paid` + tier 5 granted → web tools unlock → **no duration/term string rendered
  to the user anywhere** (TASK_181 wording rule).
- Invoice unit tests green (fake-db wallet pattern).

## 4. REGRESSIONS + DEPLOY-STATE
- `npx tsc --noEmit` → 0; ESLint on touched files → 0 NEW (stash A/B for baselines;
  admin-panel carries pre-existing errors — do NOT fix them).
- Suites: `test:xdevice` 38 · `test:devices` 6 · `test:wallet` 63 · `test:vantra` 90 ·
  `test:wrapper-cookie` 6 · `test:maintenance-cache` 6 · `test:wrapper-carrier` 6 ·
  hosting suites · the new module suite — all green.
- Prior tasks intact: TASK_185 (maintenance `no-store` header + client
  `cache:"no-store"`), TASK_186 (payment-notify wired in both billing routes — grep),
  joker page live on spaceworker.instaweb.top, TASK_183 wrapper (window → hosted,
  `cargo check --locked` 0).
- Deploy-state: fresh BUILD_ID, service active, site 200, repo↔box md5 parity on touched
  files, secrets scan over new commits.

## 5. HANDOFF + REPORT
- Check off / append evidence in `TASK_184_STEPS.md`; mark TASK_184 phases complete;
  refresh `SENIOR_HANDOFF.md` §6 with your verified state; REWRITE THIS PROMPT for the
  next agent; `git commit -F` explicitly; push.
- Report: PASS/FAIL table over §1–§3, regression output, deploy-state evidence (BUILD_ID,
  chunk greps), and an OPENLY UNVERIFIED list (browser clicks you couldn't drive,
  owner-only VM runs) + the next queued item.
