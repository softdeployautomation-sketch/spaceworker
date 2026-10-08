# TASK_184 — WEB FREE-TIER LOCKS + TICKET-BASED PREMIUM REQUEST

**Owner (2026-10-08), verbatim scope:**
> "i want free users on the web app to be restricted from using extractor, just
> lock it the same way, and also cyberlabs and hosting. all should be locked.
> and for the web app, i dont want the subscription amount displayed again, i
> just want users to request for premium through the ticket… if user click on
> upgrade to premium, it should just take them to support ticket and we find a
> way to put a dropdown and select 'request for premium' on the support ticket,
> and we can add other templates, and user sends to admin, then admin sends an
> invoice, the invoice will be in the users details carrying all our payment
> method, so users can then pay that amount."

**Owner restated the shape (2026-10-08, after the A1 inventory):**
> "its a simple fix for the whole task.. just make sure all free users cant
> access any other items, they can only go into the tab to see what its like,
> not do anything except the device which is also restricted to the tools and
> command. then take out the subscription pricing, and make the subscription a
> request.. then make all tier 3 strict to use only device and tier 5 use all
> the platforms."

**NOT in scope:** wrapper/TASK_183 (done), wallet spend flows (already gated
server-side), admin manual grant (works, P5). Web only — the wrapper's
Subscribe→billing path stays as-is (its $500 card is a wrapper feature and
must keep working — it is the ONLY surface allowed to show a price).

**RULES FOR THE AGENT IMPLEMENTING THIS (binding):**
- **STEP 0, before any code: create `TASK_184_STEPS.md`** — one checkbox per
  step below + a PRE-COMPACT SNAPSHOT section (model: `TASK_181_STEPS.md`).
  Update it after EVERY step — context WILL compact and the steps file is
  how you resume. Playbook: `HOW_WE_MOVE_FAST.md` (§7 gates → §2/§3 deploy
  → §4/§6 live evidence).
- Never `git stash`; never touch TASK_133; never edit `.env`; no secrets in
  commits/docs (placeholders only); money/invoice code in a SEPARATE commit
  from UI.

**STATUS (2026-10-08):** A1 ✅ A2 ✅ done (commit `8fec0ac` — module gate on
19 write routes, gates green). REMAINING: **A3, A4, A5, C1–C5, B1–B5.**

---

## Phase A — lock extractor + cyberlabs + hosting for free users (mirror the devices lock)

- [x] **A1 inventory** — for each module list pages + mutating API routes and the
      entitlement key that already exists (lib/entitlements.ts ENTITLEMENT_KEYS,
      products.ts): extractor (`/dashboard/extract` + extract APIs), cyberlabs
      (`/dashboard/cyberlabs` + APIs), hosting (`/dashboard/hosting` + APIs).
      Note which routes ALREADY gate (devices pattern: lib/device-gate.ts
      `deviceToolsDenied` → 403 `device_tools_required` / `xdevice_required`).

  **RESULT (2026-10-08):**
  - **Keys** (ENTITLEMENT_KEYS): `extractor`, `cyberlab`, `hosting` all exist;
    products: `extractor_module`→[extractor], `hosting_module`→[hosting];
    **cyberlab has NO store product** (admin-grant only today).
  - **Client check available:** `GET /api/entitlements` → `{keys, premium, grants}`.
  - **EXTRACTOR — ungated today.** Page `/dashboard/extract` (2175 L) →
    mutations: POST `/api/jobs`, PATCH|DELETE `/api/jobs/[id]`, POST
    `/api/jobs/[id]/stop`, `/validate`, `/leads/delete-invalid`,
    `/leads/delete-duplicates`, `/api/jobs/merge`, `/api/leads/upload`,
    `/api/leads/merge`, PATCH `/api/settings/extract-region`. Reads (GET
    `/api/jobs`, `/api/jobs/[id]`, GET extract-region, GET `/api/exe/extract*`)
    stay open. `/api/exe/*` = standalone-exe licensed surface — NOT touched.
  - **CYBERLAB — server side DONE already**: POST `/api/cyberlab/consent`
    gated (`cyberlab` key), GET `/api/cyberlab/status` = read (returns
    `gate.entitled`), panel renders a non-entitled branch at
    `cyberlab-panel.tsx:139`. No other user-side mutations (engine is C1
    scaffolding). Admin routes out of scope.
  - **HOSTING — half gated (collections yes, `[id]` mutations NO):** GATED:
    credentials, files, links, sites, sites/[id]/revisions, publish, status.
    **OPEN mutations to gate:** credentials/[id] PATCH|DELETE, verify POST,
    default POST, domains POST, domains/[id] POST|DELETE, files/[id]
    PATCH|DELETE, links/[id] PATCH|DELETE, sites/[id] DELETE. UI: hosting-panel
    just `if (!res.ok)` → free user sees "Couldn't load status" error, no lock.
  - **Shape:** device gate = `{error:"xdevice_required"}`; existing hosting
    gates use `{error:"Hosting isn't…", code:"not_entitled"}`; NO test or
    component reads `not_entitled` → safe to unify to `*_required`.
  - **Support (B2 target):** `components/support-widget.tsx` (floating widget)
    + `/api/support/tickets` (user) + admin support routes — no dashboard page.
- [x] **A2 API gates** — reuse the device-gate pattern per module: every
      mutating/action route 403s for free tier with the same `*_required`
      reason shape. Read-only list/metadata endpoints stay open (free users
      can SEE the module like they can see devices).

  **RESULT (A2, 2026-10-08, commit `8fec0ac`):**
  `lib/module-gate.ts` → `moduleToolsDenied()` (entitlement-KEY based, not
  tier-number based) → 403 `{error, code:"module_required"}` with
  `extractor_required` / `cyberlab_required` / `hosting_required`; wired
  into **19 mutation handlers** — extractor: POST `/api/jobs`,
  PATCH|DELETE `/api/jobs/[id]`, POST stop, POST validate, POST
  leads/delete-invalid, POST leads/delete-duplicates, POST jobs/merge, POST
  leads/upload, POST leads/merge, PATCH settings/extract-region;
  hosting: credentials/[id] PATCH|DELETE, verify, default, domains POST,
  domains/[id] POST|DELETE, files/[id] PATCH|DELETE, links/[id]
  PATCH|DELETE, sites/[id] DELETE; cyberlab: POST consent (normalized to
  the code shape). Reads open by design. `tests/hosting-user-domains.test.ts`
  stubs the gate OPEN (its scope = domain ownership; A4 owns gate tests).
  Gates at commit: tsc 0 · eslint 0-new · xdevice 38/38 · devices 6/6 ·
  wallet 63/63 · hosting suites 274+55/55 · lead-duplicates pass.
- [ ] **A3 UI locks** — server gates are the real protection; this is UX:
  1. Create shared `components/module-tool-lock.tsx` — copy the
     `ToolLockCard` pattern from `components/device-console.tsx:1571-1673`
     (what free users already see on device tools): title + feature bullets
     + **"Upgrade to Premium"** button → support ticket with
     `?template=premium` (B2; until B2 lands, link `/dashboard/settings`).
  2. Entitlement source = `GET /api/entitlements` → `keys`, exactly the
     pattern at `components/device-console.tsx:599-674`
     (`{ cache: "no-store" }`, default-open until it answers).
  3. Targets: `app/dashboard/extract/page.tsx` — banner when `keys` lacks
     `extractor`, primary action buttons visually disabled;
     `components/hosting-panel.tsx` — banner when lacks `hosting` (today it
     just shows "Couldn't load status"); `components/cyberlab-panel.tsx` —
     non-entitled branch already exists at `:139`, verify it blocks actions
     and add the card for consistency. Pages stay browsable (GETs open).
- [ ] **A4 tests** — new `tests/module-route-gate.test.ts` mirroring
      `tests/xdevice-route-gate.test.ts` (same require-hook + fake-db +
      `server-only` stub pattern; add `"test:module-gate"` to package.json
      beside `test:xdevice`). Cases: free session → 403 `extractor_required`
      on POST `/api/jobs` + PATCH extract-region, 403 `hosting_required` on
      one `[id]` mutation, 403 `cyberlab_required` on consent; the GET
      counterparts never hit the gate; **entitled fake grant (key
      extractor/hosting) passes the gate**; **tier-3 session → same 403s
      (Phase C) + a devices route allowed** (positive control — reuse the
      xdevice-tier harness so we prove we didn't over-lock); static lock
      that all 19 A2 route files contain `moduleToolsDenied(`.
- [ ] **A5 gates** — tsc 0 · eslint 0-new · new suite + test:xdevice +
      test:devices (no regression to the devices lock) · deploy · live curl
      403 with free session, 200 with premium session.

## Phase B — ticket-based premium request (no prices on web)

- [ ] **B1 strip subscription prices from WEB** — branch on the existing
      wrapper detection (`useWrapperMode()` from
      `components/wrapper-mode-context.tsx`, or the `sw_wrapper` cookie —
      `lib/wrapper-mode.ts:66 WRAPPER_MODE_COOKIE`):
      - `app/dashboard/billing/page.tsx` — the premium/xdevice quote card
        (amount render ~`:309-310`, quote state ~`:619-663`): WEB shows
        "Upgrade to Premium" with **NO amount** → ticket CTA; WRAPPER keeps
        the full price + Subscribe flow (owner tested it working — it must
        not regress).
      - `app/dashboard/settings/page.tsx:56-101` — same split: web hides
        `xdevicePrice`, wrapper keeps it.
      - Wallet TOP-UP amounts stay (that's funds, not a subscription).
      `components/store.tsx` module prices stay (owner said *subscription*
      pricing).
- [ ] **B2 support ticket template** — `SupportTicket.category String?`
      already exists (`prisma/schema.prisma:3576`, "free-text classification
      for the admin queue filter") → **NO migration**: the support form
      (`components/support-widget.tsx` + POST `/api/support/tickets`) gets a
      template `<select>` defaulting to **"Request for Premium"** sent as
      `category:"premium_request"`, with room for more templates
      ("Technical issue", "Billing question", …); the widget preselects on
      `?template=premium`; every Upgrade CTA (A3 cards, B1 web card) opens
      it that way.
- [ ] **B3 admin invoice** — admin: premium-request tickets flagged in the
      support inbox; on the user detail an action **"Send invoice"**: amount
      (admin-entered) + our payment methods (same configured source the
      billing page shows) → stored in a NEW additive model
      `PremiumInvoice { id, userId, amountUsd, status "open"|"paid",
      methods Json, createdAt, paidAt? }` (additive-only migration — house
      rule) → visible to that user only.
- [ ] **B4 user pays** — billing page shows the open invoice (amount +
      methods + instructions); user pays externally and submits through the
      EXISTING `/api/billing/submit` | `/api/billing/topup` (invoice ref
      optional); on admin approval → mark invoice `paid` + grant tier 5 via
      the existing `grant-premium {tier:5}` path (admin-set term; **duration
      never shown to the user anywhere** — TASK_181 wording rule). NO new
      payment rails.
- [ ] **B5 tests + gates + deploy** — invoice lifecycle unit tests (fake-db
      wallet pattern: create → owner-only visibility → pay → tier 5 granted
      → settled), ticket-template test, static lock that no subscription
      amount renders on web outside the wrapper branch, full gate battery
      (below), live e2e with a test account (owner validates).

## Phase C — tier-3 (Premium XDevice) behaves like FREE on the web app

Owner (2026-10-07): people who subscribe for XDevice (tier 3) get **one
organization + devices in the wrapper**; on the **web app** they must be limited
exactly like a free user — they can SEE the other tools (extractor, cyberlabs,
hosting, …) but can't ACCESS them, and they request premium through the same
ticket flow as a free user to unlock the web tools. The devices entitlement is
the ONLY thing tier 3 carries on the web.

- [ ] **C1 entitlement audit** — verify `isXdeviceLive`
      (lib/entitlements.ts) adds ONLY `devices` to tier-3 keys and every
      other key (extractor/cyberlabs/hosting/web…) stays ungranted at tier 3;
      grep `tier >=|tier >|tier === 5` across `app/api` — no tier-NUMBER
      check may decide module access anywhere (entitlement keys only).
- [ ] **C2 gate alignment** — A2's `moduleToolsDenied` already keys off
      `hasEntitlement` (not tier numbers), so a tier-3 session hitting an A2
      route gets the same 403 `*_required` as a free user. Prove it in A4's
      tests (tier-3 case) — don't assume.
- [ ] **C3 billing for tier 3 on web** — tier-3 user opening web
      `/dashboard/billing` sees the same "Upgrade to Premium" ticket CTA
      (B1/B2) as free users; the WRAPPER's XDevice subscribe flow stays
      untouched.
- [ ] **C4 tests** — extend A4: tier-3 session asserted against every Phase A
      gate (403) AND allowed on devices routes (200) — the positive control
      that proves we didn't over-lock.
- [ ] **C5 gates + live check** — battery + e2e: tier-3 account on web sees
      locked tools + ticket CTA; same account in wrapper keeps device access.

## Order
**Step 0 = create `TASK_184_STEPS.md`** (header rules — do this first), then
A3 → A4 → A5, then C1–C5 (C2/C4 largely ride on A4's tier-3 test cases, C5
is one live check), then B1 → B5. Owner validates Phase A on web before
Phase B ships. Verification afterwards runs against
`PROMPT_NEXT_VERIFICATION_AGENT.md` (rewritten for TASK_184).