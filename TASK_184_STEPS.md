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

**STATE (2026-10-08, AFTER CONTEXT COMPACTION #2 — PHASE A CODE FULLY COMMITTED;
main @ `fcfde55`; commits: `8fec0ac` A2 · `a345c7b` A3 · `30e03d2` steps ·
`fcfde55` A6+N1-N3+A4, 27 files +1084/−106):**
- **A1 ✅ A2 ✅ A3 ✅** (as before — see DONE LOG).
- **A6 ✅ commit `fcfde55`** — addendum 1, private-browser lock:
  - A6.1 `lib/entitlements.ts:12` — `"browser"` appended to `ENTITLEMENT_KEYS` (const
    only, no migration; tier 5 ⇒ all keys, tier 3 ⇒ `devices` only ⇒ browser locked).
  - A6.2 all 7 browser MUTATION routes now call `moduleToolsDenied(userId, "browser")`
    right after the session check → 403 `{error:"browser_required"}`:
    POST `/api/browser-profiles` · POST `/api/browser-sessions` · DELETE
    `/api/browser-profiles/[id]` · PUT `.../byo-proxy` · DELETE
    `/api/browser-sessions/[id]` · POST `.../switch` (gate BEFORE canUseExitNodes) ·
    POST `/api/browser-sessions/byo-test`. `resolveUserTier` imports REMOVED from
    browser routes; GET/read routes untouched (open by design). `lib/module-gate.ts`
    `MODULE_CODES` gained `browser:"browser_required"`.
    Admin `app/api/admin/users/[id]/entitlements/route.ts` error now derives from
    `ENTITLEMENT_KEYS.join(", ")` (the hand-written list had also been missing
    `hosting`).
  - A6.3 `app/dashboard/browser/page.tsx` computes `listEffectiveEntitlements` →
    `entitled` prop (REPLACES `tier`) on both panels + renders shared
    `<ModuleToolLockCard moduleKey="browser">` above the panel (tabs stay visible).
    `components/browser-session-panel.tsx`: prop `tier:number`→`entitled:boolean`,
    launcher wrapped `{entitled && …}`, sessions/history list stays visible for
    everyone; old dead `tier < 1` amber box removed. Profiles panel: prop swapped,
    `New Profile` button gated on `entitled`, amber "Pro plan" box removed.
  - A6.4 tests → still part of A4 (below).
- **N1 ✅ N2 ✅ N3 ✅ commit `fcfde55`** — naming migration (display-name only, NO DB
  change; see NAMING MIGRATION note): `lib/plan-name.ts` created (client-safe:
  `PLAN_PREMIUM_PLUS`/`PLAN_PREMIUM_XDEVICE`/`PLAN_FREE`/`planLabelForTier`/
  `UPGRADE_TO_PREMIUM_PLUS`/`REQUEST_PREMIUM_PLUS_LABEL`). Swept user-facing strings:
  `components/module-tool-lock.tsx` CTA → `UPGRADE_TO_PREMIUM_PLUS` (import added);
  `components/device-console.tsx` ToolLockCard → "Subscribe to Premium XDevice — $X";
  `app/dashboard/billing/page.tsx` — subscribe heading (XDevice vs "Upgrade to
  Premium Plus"), "Pro plan gives your jobs…", status-card `h2` + "— Active" badge
  (both now product-dependent), activation copy ("Premium XDevice activated." /
  "Premium Plus active until …" / "Premium Plus activated for 30 days."), already-
  active + wallet-activate copy + "Activate Premium Plus — $"; campaigns
  `confirm-test` + `deliverability-decision` → "upgrade to Premium Plus";
  `lib/email.ts` → "Upgrade to Premium Plus"; `components/hosting-panel.tsx` 2×
  "part of Premium Plus" + picker note "…both part of Premium Plus"; `app/api/wallet/
  spend` → "the web subscription (Premium Plus) and Premium XDevice only";
  `grant-premium` validation → "3 (Premium XDevice) or 5 (Premium Plus)".
  Server ledger notes/API codes NOT renamed (TASK_181 tests assert them).
  **N4 (static naming test) still open → belongs to B5.**
- **A4 ✅ COMPLETE (13/13 green)** — `tests/module-route-gate.test.ts` (697 L) +
  `"test:module-gate"` script. House pattern: require-hook (`server-only` /
  `next/server` / `./db` / in-map `overrides` interception) + fakeDb (users+grants +
  reversion filters) + fakePrisma + device/consent recorders + `loadRoute()`.
  13 tests: 401-first · free→403 extractor/hosting/cyberlab/browser (consent never
  recorded) · free GETs open · tier3 same-403s (C2/C4) · tier3 device positive
  control · expired-tier3 flip → `xdevice_required` · tier5 passes all 6 mutations ·
  grant row opens only its own key · revoked/expired grant closes · `devices` grant
  opens device but NOT web modules · static: 19 A2 files still gated · static: 7
  browser mutations gated key-based (8 route files, no tier numbers) · static:
  MODULE_CODES ↔ ENTITLEMENT_KEYS, all codes `*_required`.
- **GATES NOW (all green):** `npx tsc --noEmit` = **0** ✅ · eslint on all touched
  files = **0 NEW** ✅ (8 × `react-hooks/set-state-in-effect` are PRE-EXISTING at
  HEAD, verified per-file via `git show HEAD:…|eslint --stdin`: extract/page 3,
  browser-session-panel 3, hosting-panel 1, cyberlab-panel 1) ·
  **tests:** module-gate 13/13 · xdevice 38/38 · devices 6/6 · hosting 338/338 ·
  lab 10/10 · wallet 63/63 · deliverability 6/6 · wrapper-cookie 6/6 · smtp 11/11 ·
  message 15/15 · testrecipients 13/13 · target 10/10 · support 50/50
  (one observed flake in "read cursor moves FORWARDS" — 3 clean reruns, zero
  support files touched by this task, not ours).
- **WORKING TREE:** clean after commit `fcfde55` (only untracked file is
  `TASK_133_RMM_ENGINE_BRINGUP.md` — UNTRACKED-but-NEVER-TOUCH, house rule).
- **NEXT ACTION:** **A5 deploy (§2 tar-over-ssh) + live curl 403 free / 200 premium (§4)**
  → C3/C5 live checks (tier-3 web sees locked tools + ticket CTA; wrapper keeps
  devices) → then B1–B5 (B1/B2/B4 web ticket flow for BOTH requestable plans —
  Premium Plus (tier 5) and Premium XDevice (tier 3), invoice pre-filled with the
  configured default price and admin-editable before sending; B3 = money commit,
  SEPARATE; N4 naming static test rides B5).

**PREVIOUS SNAPSHOT (STEP 0):**
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
- [x] **A3 UI locks** — DONE ✅ commit `a345c7b` (UI only; gates tsc 0 · eslint 0-new)
  - [x] A3.1 `components/module-tool-lock.tsx` created (ToolLockCard shape): title +
        bullets + "Upgrade to Premium" → `/dashboard/settings?template=premium`
        (B2 flips this to the support ticket).
  - [x] A3.2 `useEntitlementKeys()` / `useModuleLock()` = `GET /api/entitlements`
        `{cache:"no-store"}`, DEFAULT-OPEN (failed read ⇒ no lock), same pattern as
        device-console:599-674. Card accepts a server-computed `entitled` prop.
  - [x] A3.3 extract page — banner after the header; disabled while locked: Search,
        Import leads, merge sessions, Pause/Resume/Stop/Delete, Validate all,
        Delete duplicates, Delete invalid, upload picker.
  - [x] A3.4 hosting panel — the one-line "isn't included" note replaced by the card
        (driven by `status.entitled`, always-200 status route); "Upload zip → preview"
        + "Add domain" submits now honour `!status.entitled` (Create site / Upload &
        get a link / Create link already did).
  - [x] A3.5 cyberlab panel — non-entitled note replaced by the card
        (`entitled={status.entitled}`); AUP stays `status.entitled`-gated, consent POST
        403s server-side (A2).
  - [x] A3.6 gates ✅ — `npx tsc --noEmit` = 0 · eslint 0 NEW (extract 4→4, cyberlab
        3→3, hosting 1→1 = pre-existing `react-hooks/set-state-in-effect`, proven by
        `git show HEAD:<file> | eslint --stdin`; new file clean) · commit `a345c7b`.
- [x] **A4 tests** — `tests/module-route-gate.test.ts` mirroring
      `tests/xdevice-route-gate.test.ts`; add `test:module-gate` to package.json.
      Cases: free → 403 `extractor_required` (POST `/api/jobs`, PATCH extract-region),
      403 `hosting_required` on one `[id]` mutation, 403 `cyberlab_required` (consent);
      GET counterparts never hit the gate; entitled fake grant passes; **tier-3 session →
      same 403s + devices route allowed (positive control, Phase C)**; static lock that all
      19 A2 route files contain `moduleToolsDenied(`.
- [ ] **A5 gates** — tsc 0 · eslint 0-new · `test:module-gate` + `test:xdevice` +
      `test:devices` green · deploy (§2 tar-over-ssh) · live curl 403 free / 200 premium (§4).
      **CODE GATES GREEN 2026-10-08** (tsc 0 · eslint 0-new · module-gate 13/13 ·
      xdevice 38/38 · devices 6/6 · hosting 338/338 · lab/wallet/deliverability/
      smtp/message/testrecipients/target green) — REMAINING: deploy §2 + live curl §4.

## Phase C — tier-3 (Premium XDevice) behaves like FREE on the web

- [x] **C1 entitlement audit** — `isXdeviceLive` adds ONLY `devices` to tier-3 keys; grep
      `tier >=|tier >|tier === 5` across `app/api` → no tier-NUMBER check may decide module
      access (entitlement keys only). Record findings (incl. anything intentional).
      **RESULT 2026-10-08:** grep `tier >=|tier >|tier === [0-9]|tier <` in `app/api`
      = exactly 4 hits, ALL intentional & none deciding module access:
      `auth/login/route.ts:78` (`tier < 5` → account `accessType` license_only/full) ·
      `admin/users/[id]/grant-premium/route.ts:69` (`tier === 3` dispatches
      grantXdeviceTerm vs grantPremium — an entitlement WRITE, not a read-gate) ·
      `admin/users/[id]/tier/route.ts:24` (input validation `tier < 0`).
      `resolveUserTier` appears ONLY in `api/jobs:346` → `priorityTier` (lane
      priority). **Loop-grep: ZERO files importing `moduleToolsDenied` contain any
      tier-number check.** Inventory: moduleToolsDenied 26 files, deviceToolsDenied 17.
- [x] **C2 gate alignment** — prove in A4's tier-3 cases that a tier-3 session gets the same
      403 `*_required` (don't assume). [rides on A4]
      **PROVEN 2026-10-08** by `tests/module-route-gate.test.ts` test 4: live tier-3
      → `extractor_required` (jobs POST + extract-region PATCH), `hosting_required`
      (files [id] DELETE), `cyberlab_required` (consent), `browser_required`
      (profiles + sessions POST) — every body deepEqual-matched the FREE user's.
- [ ] **C3 billing for tier 3 on web** — tier-3 user opening web `/dashboard/billing` sees
      the same "Upgrade to Premium" ticket CTA (B1/B2) as free users; wrapper XDevice
      subscribe flow untouched.
- [x] **C4 tests** — extend A4: tier-3 asserted against EVERY Phase A gate (403) AND allowed
      on devices routes (200) — positive control, proves we didn't over-lock.
      **DONE 2026-10-08** (tests 4-6): tier-3 → 403 with exact code on a representative
      mutation of EVERY Phase A module (extractor ×2, hosting, cyberlab, browser ×2) ·
      device route 200 + `runCommandNow` reached (test 5) · expired term flips device
      route to 403 `xdevice_required` (test 6) · static lock (test 11/12) proves all
      19 A2 + 7 browser route FILES carry `moduleToolsDenied(` — so per-route behavior
      coverage is representative-per-module + file-presence-for-all-26.
- [ ] **C5 gates + live check** — battery + e2e: tier-3 account on web sees locked tools +
      ticket CTA; same account in wrapper keeps device access.

## Phase B — ticket-based premium request (no prices on web)

- [ ] **B1 strip subscription prices from WEB** (branch on `useWrapperMode()` /
      `sw_wrapper` cookie): `app/dashboard/billing/page.tsx` premium/xdevice quote card →
      WEB "Upgrade to Premium" with NO amount → ticket CTA, WRAPPER keeps price + Subscribe;
      `app/dashboard/settings/page.tsx:56-101` same split. Wallet TOP-UP amounts stay;
      `components/store.tsx` module prices stay. **WRAPPER branch must not regress.**
- [ ] **B2 support ticket templates (SCOPED 2026-10-08 — TWO plans)** — NO
      migration (`SupportTicket.category` is free-text, `prisma/schema.prisma:3576`)
      → the support form (`components/support-widget.tsx` + POST
      `/api/support/tickets`) gets a `<select>` of templates:
      1. **"Request for Premium Plus"** → `category:"premium_request_plus"` (tier 5
         — unlocks every web module: extractor/cyberlabs/hosting/browser/mail/agent);
      2. **"Request for Premium XDevice"** → `category:"premium_request_xdevice"`
         (tier 3 — devices only);
      3. room for more ("Technical issue", "Billing question", …).
      Widget preselects from `?template=` (`premium-plus` default → template 1,
      `premium-xdevice` → template 2); every Upgrade CTA opens it that way:
      module lock cards (extractor/cyberlab/hosting/browser) → premium-plus;
      the device ToolLockCard on web → premium-xdevice (both plans unlock devices,
      XDevice is the cheaper preselect the user can switch).
      Admin queue filters on those two category values (flagged as premium requests).
- [ ] **B3 admin invoice (MONEY — own commit, after B1/B2 land)** — premium-request
      tickets flagged in the support inbox; on the user detail an action
      **"Send invoice"**:
      - **plan select: Premium Plus (tier 5) | Premium XDevice (tier 3)**;
      - **amount input PRE-FILLED with the configured default for that plan** —
        Premium Plus ← `webSubscriptionPriceUsd`, Premium XDevice ←
        `xdevicePriceUsd` (both from the admin Wallets & Prices settings, read live,
        never hardcoded) — **admin can edit the amount before sending** (and re-edit
        while the invoice is still `open`);
      - payment methods = the same configured source the billing page renders
        (crypto addresses from admin settings) snapshotted onto the invoice;
      - stored in a NEW additive model
        `PremiumInvoice { id, userId, plan "premium_plus"|"premium_xdevice", tier
        3|5, amountUsd, status "open"|"paid", methods Json, createdAt, paidAt? }`
        (additive-only migration — house rule) → visible to that user only.
- [ ] **B4 user pays (SCOPED: both plans)** — billing page shows the open invoice
      (plan name "Premium Plus"/"Premium XDevice" + amount + methods + instructions);
      user pays externally and submits through the EXISTING `/api/billing/submit` |
      `/api/billing/topup` (invoice ref optional); on admin approval → invoice
      `paid` + grant **the invoice's own tier** through the existing
      `grant-premium {tier: 3|5}` path (admin-set term; **duration never shown to
      the user anywhere** — TASK_181 wording rule). NO new payment rails.
- [ ] **B5 tests + gates + deploy** — invoice lifecycle unit tests (fake-db pattern: create →
      owner-only visibility → pay → tier 5 granted → settled), ticket-template test, static
      lock that no subscription amount renders on web outside the wrapper branch, full gate
      battery, live e2e with a test account (owner validates).

---

## ORDER (binding)
`STEP 0 ✅ → A3 → A4 → A5 → C1–C5 (C2/C4 ride on A4, C5 = one live check) → B1 → B5`.
Owner validates Phase A on web before Phase B ships.

## OWNER ADDENDUM (2026-10-08, same session)
> "also the private browser should be locked out for tier 3"

- [x] **A6 private browser lock** (web module `/dashboard/browser`, nav "Private
      Browser") — today: server POSTs already refuse `tier < 5` (so free AND tier 3
      get 403 on start), BUT (a) the check is a TIER NUMBER (violates the C1 rule —
      entitlement keys only) and (b) the UI shows the full launcher to anyone with
      `tier >= 1`, so tier 3 sees an unlocked browser they cannot use.
  - [x] A6.1 add `"browser"` to `ENTITLEMENT_KEYS` (additive const — NO migration;
        `UserEntitlement.key` is a free string). Premium (tier 5) ⇒ every key incl.
        `browser`; tier 3 ⇒ `devices` only ⇒ locked; free ⇒ locked. Admin can grant
        it (admin entitlements route uses `isEntitlementKey`).
  - [x] A6.2 swap the `tier < 5` / `resolveUserTier` checks in the browser MUTATION
        routes for `moduleToolsDenied(userId, "browser")` → 403 `browser_required`:
        POST `/api/browser-profiles`, POST `/api/browser-sessions`, DELETE
        `/api/browser-profiles/[id]`, PUT `.../byo-proxy`, DELETE
        `/api/browser-sessions/[id]`, POST `.../switch`, POST
        `/api/browser-sessions/byo-test`. GET/read routes stay open (browse-able).
  - [x] A6.3 UI: server page `app/dashboard/browser/page.tsx` computes
        `listEffectiveEntitlements` → `entitled` prop (replaces `tier`) passed to
        `BrowserSessionPanel` + `BrowserProfilesPanel`; both panels swap their
        `tier >= 5` / `tier >= 1` conditions for `entitled`; page renders the shared
        lock card when not entitled (tabs still visible = "can see, can't do").
  - [ ] A6.4 tests in A4: free + tier-3 → 403 `browser_required` on POST
        `/api/browser-sessions`; entitled fake grant passes; static lock that no
        `tier < 5` / `tier >= 5` decides browser-module access.

## OWNER ADDENDUM 2 — NAMING (2026-10-08, same session)
> "tier 3 users will also show Premium when they login on the web, but won't be
>  able to access the other tools. That means we need to distinguish the premium,
>  so when that user wants to request for the tier 5 premium, we need to use
>  another name for that, I think that should be premium plus. And tier 3 remains
>  premiumxdevice."

**RULE (binding, applies to every user-facing string):**
- **tier 5 (web full access) = `Premium Plus`** — every upgrade CTA, plan badge,
  activation/already-active copy, invoice + ticket template wording that asks for
  tier 5.
- **tier 3 = `Premium XDevice`** — the XDevice/wrapper surface only.
- free = `Free`. **Server ledger notes / API error strings are NOT renamed**
  (TASK_181 tests assert them, e.g. `Premium — 30 days (web_subscription)`).

- [x] **N1 single source of truth** — new client-safe `lib/plan-name.ts`:
      `PLAN_PREMIUM_PLUS="Premium Plus"`, `PLAN_PREMIUM_XDEVICE="Premium XDevice"`,
      `planLabelForTier(tier)`, `UPGRADE_CTA="Upgrade to Premium Plus"`. No
      `server-only`, importable from both server pages and client components.
- [x] **N2 apply to web upgrade path (tier-5 asks)** —
      `components/module-tool-lock.tsx` CTA → "Upgrade to Premium Plus";
      `app/dashboard/billing/page.tsx` (web branch of `Upgrade to Pro`,
      `One month of Pro`, `Activate Pro`, `Premium activated…`, `Premium is already
      active…`); `app/dashboard/settings/page.tsx` `plan` badge (tier ≥5 →
      Premium Plus, tier 3 → Premium XDevice, else Free) + its `plan === "Pro"`
      tone check.
- [x] **N3 apply to the XDevice surface (tier 3 keeps its name)** — settings card
      `h2` "Premium" → "Premium XDevice" + its "Subscribe to Premium — $x" line;
      `app/dashboard/billing/page.tsx` `product === "xdevice"` copy
      ("Subscribe to Premium…", "Premium activated."); device-console
      `ToolLockCard` wrapper label "Subscribe to Premium — $X" → "Subscribe to
      Premium XDevice — $X" (wrapper keeps the price — it is the ONLY priced
      surface).
- [ ] **N4 naming gates** — static test (B5) that no user-facing tier-5 CTA says
      plain "Upgrade to Premium"/"Pro" and no XDevice surface says plain "Premium";
      tsc 0 · eslint 0-new · commit (UI copy — separate from the B3 money commit).

- 2026-10-08 NAMING MIGRATION ✅ SCOPED — owner: "current users on premium right now
  get migrated to premium plus, so users on premiumxdevice don't conflict; free users
  can request either device premium or premium plus." → **DISPLAY-NAME migration only,
  NO data/DB change**: tier-5 rows stay tier 5, they now READ as **Premium Plus**
  everywhere user-facing (`lib/plan-name.ts`: tier ≥5 → Premium Plus, tier 3 →
  Premium XDevice, else Free); tier 3 keeps **Premium XDevice** (no conflict); free
  users request either plan via B2's two ticket templates. Server-side ledger notes /
  API codes keep TASK_181 verbatim strings (tests assert them).
- 2026-10-08 SCOPE REFINEMENT ✅ — B2/B3/B4 rescoped per owner: **two requestable
  plans** (Premium Plus = tier 5, Premium XDevice = tier 3); invoice pre-filled with
  each plan's configured default price (`webSubscriptionPriceUsd` / `xdevicePriceUsd`)
  and **editable by admin before sending**; approval grants the invoice's own tier via
  the existing `grant-premium {tier:3|5}` path.

## DONE LOG (append after every step)
- 2026-10-08 STEP 0 ✅ — `TASK_184_STEPS.md` created at main `672511a` (commit `30e03d2`).
- 2026-10-08 A3 ✅ commit `a345c7b` — shared lock card + extractor/hosting/cyberlab
  UI locks; tsc 0, eslint 0-new. Owner addendum 1 (private browser, A6) and
  addendum 2 (naming: Premium Plus / Premium XDevice) recorded above.
- 2026-10-08 A6 ✅ commit `fcfde55` — `browser` entitlement key + all 7 mutation
  routes gated `browser_required` + page/panels `entitled` swap + shared lock card;
  admin entitlements message derived from `ENTITLEMENT_KEYS`. tsc 0 · eslint 0-new.
- 2026-10-08 N1/N2/N3 ✅ commit `fcfde55` — `lib/plan-name.ts` + full user-facing sweep
  (tier 5 → Premium Plus, tier 3 → Premium XDevice; billing/device-console/lock-card/
  campaigns/email/hosting/wallet/grant-premium). N4 static test remains → B5.
- 2026-10-08 A4 ✅ commit `fcfde55` — `tests/module-route-gate.test.ts` finished
  (697 L, 13/13 green) + `test:module-gate` script. Full battery green: xdevice
  38/38, devices 6/6, hosting 338/338, lab 10/10, wallet 63/63, deliverability
  6/6, smtp/message/testrecipients/target green; support 50/50 (1 observed flake →
  3 clean reruns, not ours). tsc 0 · eslint 0-new (8 pre-existing at HEAD,
  per-file verified).
- 2026-10-08 COMMIT ✅ — `fcfde55` "TASK_184 A6+N1-N3+A4 — private-browser module
  lock, Premium Plus/XDevice naming, module-gate route tests" (27 files,
  +1084/−106; new: `lib/plan-name.ts`, `tests/module-route-gate.test.ts`).
  Working tree clean; TASK_133 file untouched/untracked.
- 2026-10-08 C1/C2/C4 ✅ (code-level) — C1 audit grep: 4 tier-number hits in
  `app/api`, ALL intentional non-module-access (login accessType · admin grant
  dispatch · admin input validation); `resolveUserTier` only feeds jobs
  `priorityTier`; ZERO `moduleToolsDenied` files contain tier checks. C2/C4
  proven by `module-route-gate` tests 4-6 (tier-3 same 403s on every module's
  representative mutation + device 200 positive control + expired flip) with
  static file-presence locks for all 26 routes. C3/C5 live parts ride A5's
  deploy (§2) + owner validation (§4).
