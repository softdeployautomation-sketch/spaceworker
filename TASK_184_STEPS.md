# TASK_184 — execution steps (live tracking file)

Source of truth: `TASK_184_WEB_FREE_TIER_LOCKS_TICKET_PREMIUM.md` (scope, binding) ·
`HOW_WE_MOVE_FAST.md` (playbook, binding: §7 gates → §2/§3 deploy → §4/§6 live evidence) ·
`PROMPT_NEXT_VERIFICATION_AGENT.md` (verification contract).
Repo: `/Users/mikeolab/spaceworker` · main @ `672511a` (recorded at STEP 0, 2026-10-08).

Rules tracked against:
- Never `git stash` · never touch TASK_133 · never edit `.env` · no secrets in commits/docs
  (placeholders only) · **money/invoice code in a SEPARATE commit from UI**.
- Every step ends with: `npx tsc --noEmit` = 0, ESLint clean on touched files, relevant test
  suites green, then an explicit `git commit -F /tmp/<name>-msg.txt` (never `-m` multiline).
- Update this file after EVERY step — context WILL compact; this file is how you resume.
- Web-only: the wrapper's Subscribe→billing $500 card must keep working (it is the ONLY
  surface allowed to show a price).

---

## PRE-COMPACT SNAPSHOT

**STATE AT STEP 0 (2026-10-08, main `672511a`):**
- **A1 ✅** inventory done (in `TASK_184_*.md` §A1 RESULT): keys `extractor`/`cyberlab`/
  `hosting` exist in `ENTITLEMENT_KEYS`; `GET /api/entitlements` → `{keys, premium, grants}`;
  cyberlab has NO store product; extractor was fully ungated; hosting half gated; cyberlab
  server-side already gated. Support surface = `components/support-widget.tsx` + POST
  `/api/support/tickets` (no dashboard page).
- **A2 ✅ commit `8fec0ac`** — `lib/module-gate.ts` `moduleToolsDenied()` (entitlement-KEY
  based, never tier-number) → 403 `{error:"*_required", code:"module_required"}` wired into
  **19 mutation handlers** (11 extractor + 8 hosting, cyberlab consent normalized). Reads stay
  open by design. `tests/hosting-user-domains.test.ts` stubs the gate OPEN (A4 owns gate tests).
- **REMAINING:** A3 → A4 → A5, then C1 → C5, then B1 → B5. Owner validates Phase A on web
  before Phase B ships.

**KEY FILES:**
- Gate: `lib/module-gate.ts` (47 L) · `lib/device-gate.ts` (`deviceToolsDenied`) ·
  `lib/entitlements.ts` (`ENTITLEMENT_KEYS`, `hasEntitlement`, `isXdeviceLive`) · `lib/products.ts`.
- Lock-card source pattern: `components/device-console.tsx:1571-1673` `ToolLockCard` +
  entitlement fetch `:599-674` (`GET /api/entitlements`, `{cache:"no-store"}`, default-open).
- A3 targets: `app/dashboard/extract/page.tsx` (2175 L) · `components/hosting-panel.tsx`
  (1654 L) · `components/cyberlab-panel.tsx` (175 L, non-entitled branch at `:139`) ·
  **new** `components/module-tool-lock.tsx`.
- A4 model test: `tests/xdevice-route-gate.test.ts` (require-hook + fake-db + `server-only`
  stub). Script to add: `"test:module-gate": "tsx --test tests/module-route-gate.test.ts"`
  next to `test:xdevice`.
- B1: `app/dashboard/billing/page.tsx` (amount render ~`:309-310`, quote state ~`:619-663`) ·
  `app/dashboard/settings/page.tsx:56-101` · `components/wrapper-mode-context.tsx`
  (`useWrapperMode()`) · `lib/wrapper-mode.ts:66 WRAPPER_MODE_COOKIE` (`sw_wrapper`).
- B2: `SupportTicket.category` already exists (`prisma/schema.prisma:3576`) → NO migration;
  `components/support-widget.tsx` (641 L) + POST `/api/support/tickets`; `?template=premium`.
- B3: NEW additive model `PremiumInvoice { id, userId, amountUsd, status "open"|"paid",
  methods Json, createdAt, paidAt? }` — additive-only migration (playbook §3 + §6b).
- B4: existing `/api/billing/submit` | `/api/billing/topup`; admin `grant-premium {tier:5}`;
  **duration never shown to the user anywhere** (TASK_181 wording rule). NO new payment rails.
- Deploy: VPS `root@164.68.105.96:/opt/spaceworker` (no git there — verify by hash/content,
  never `git log`); ship with **tar over ssh** (macOS rsync 2.6.9 untrusted, playbook §1);
  no git stash; never build on the VPS.

---

## Phase A — lock extractor + cyberlabs + hosting for free users

- [x] **A1 inventory** — RESULT recorded in `TASK_184_*.md` §A1 (2026-10-08).
- [x] **A2 API gates** — DONE ✅ commit `8fec0ac` — `lib/module-gate.ts` +
      `moduleToolsDenied()` in 19 mutation handlers; gates green at commit (tsc 0 · eslint
      0-new · xdevice 38/38 · devices 6/6 · wallet 63/63 · hosting 274+55 · lead-duplicates).
- [ ] **A3 UI locks**
  - [ ] A3.1 create `components/module-tool-lock.tsx` (copy `ToolLockCard`
        `device-console.tsx:1571-1673`): title + bullets + "Upgrade to Premium" →
        `/dashboard/settings?template=premium` until B2 lands (then support ticket).
  - [ ] A3.2 entitlement source = `GET /api/entitlements` → `keys`, pattern
        `device-console.tsx:599-674` (no-store, default-open until it answers).
  - [ ] A3.3 `app/dashboard/extract/page.tsx` — banner when `keys` lacks `extractor`,
        primary action buttons visually disabled.
  - [ ] A3.4 `components/hosting-panel.tsx` — banner when lacks `hosting` (today: bare
        "Couldn't load status").
  - [ ] A3.5 `components/cyberlab-panel.tsx` — verify `:139` non-entitled branch blocks
        actions; add the lock card for consistency.
  - [ ] A3.6 gates: tsc 0 · eslint 0-new · commit **UI-only** `git commit -F`.
- [ ] **A4 tests** — `tests/module-route-gate.test.ts` mirroring
      `tests/xdevice-route-gate.test.ts`; add `test:module-gate` to package.json.
      Cases: free → 403 `extractor_required` (POST `/api/jobs`, PATCH extract-region),
      403 `hosting_required` on one `[id]` mutation, 403 `cyberlab_required` (consent);
      GET counterparts never hit the gate; entitled fake grant passes; **tier-3 session →
      same 403s + devices route allowed (positive control, Phase C)**; static lock that all
      19 A2 route files contain `moduleToolsDenied(`.
- [ ] **A5 gates** — tsc 0 · eslint 0-new · `test:module-gate` + `test:xdevice` +
      `test:devices` green · deploy (§2 tar-over-ssh) · live curl 403 free / 200 premium (§4).

## Phase C — tier-3 (Premium XDevice) behaves like FREE on the web

- [ ] **C1 entitlement audit** — `isXdeviceLive` adds ONLY `devices` to tier-3 keys; grep
      `tier >=|tier >|tier === 5` across `app/api` → no tier-NUMBER check may decide module
      access (entitlement keys only). Record findings (incl. anything intentional).
- [ ] **C2 gate alignment** — prove in A4's tier-3 cases that a tier-3 session gets the same
      403 `*_required` (don't assume). [rides on A4]
- [ ] **C3 billing for tier 3 on web** — tier-3 user opening web `/dashboard/billing` sees
      the same "Upgrade to Premium" ticket CTA (B1/B2) as free users; wrapper XDevice
      subscribe flow untouched.
- [ ] **C4 tests** — extend A4: tier-3 asserted against EVERY Phase A gate (403) AND allowed
      on devices routes (200) — positive control, proves we didn't over-lock.
- [ ] **C5 gates + live check** — battery + e2e: tier-3 account on web sees locked tools +
      ticket CTA; same account in wrapper keeps device access.

## Phase B — ticket-based premium request (no prices on web)

- [ ] **B1 strip subscription prices from WEB** (branch on `useWrapperMode()` /
      `sw_wrapper` cookie): `app/dashboard/billing/page.tsx` premium/xdevice quote card →
      WEB "Upgrade to Premium" with NO amount → ticket CTA, WRAPPER keeps price + Subscribe;
      `app/dashboard/settings/page.tsx:56-101` same split. Wallet TOP-UP amounts stay;
      `components/store.tsx` module prices stay. **WRAPPER branch must not regress.**
- [ ] **B2 support ticket template** — NO migration (`SupportTicket.category` exists) →
      `<select>` in the support form defaulting to "Request for Premium"
      (`category:"premium_request"`), room for more templates; widget preselects on
      `?template=premium`; every Upgrade CTA opens it that way.
- [ ] **B3 admin invoice** — premium-request tickets flagged in support inbox; admin
      "Send invoice" action on the user detail: amount (admin-entered) + payment methods
      (same configured source the billing page shows) → NEW additive `PremiumInvoice` model
      (additive-only migration) → visible to that user only. **MONEY COMMIT (separate from UI).**
- [ ] **B4 user pays** — billing page shows open invoice (amount + methods + instructions);
      user pays externally and submits via EXISTING `/api/billing/submit` |
      `/api/billing/topup` (invoice ref optional); on admin approval → invoice `paid` +
      grant tier 5 via existing `grant-premium {tier:5}` (admin-set term; **duration never
      shown to the user**). NO new payment rails.
- [ ] **B5 tests + gates + deploy** — invoice lifecycle unit tests (fake-db pattern: create →
      owner-only visibility → pay → tier 5 granted → settled), ticket-template test, static
      lock that no subscription amount renders on web outside the wrapper branch, full gate
      battery, live e2e with a test account (owner validates).

---

## ORDER (binding)
`STEP 0 ✅ → A3 → A4 → A5 → C1–C5 (C2/C4 ride on A4, C5 = one live check) → B1 → B5`.
Owner validates Phase A on web before Phase B ships.

## DONE LOG (append after every step)
- 2026-10-08 STEP 0 ✅ — `TASK_184_STEPS.md` created at main `672511a`.
