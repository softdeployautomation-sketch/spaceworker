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
- **WORKING TREE:** code clean at `775cfa3` (B3 money) + steps commits
  (`699f119` B1+B2 · `5a60f46` steps); only untracked
  file is `TASK_133_RMM_ENGINE_BRINGUP.md` — UNTRACKED-but-NEVER-TOUCH, house rule.
- **NEXT ACTION:** **B4 user pays (SCOPED: both plans)** — billing page shows the
  open invoice (plan name + amount + snapshotted methods + instructions); user pays
  externally and submits through the EXISTING `/api/billing/submit` |
  `/api/billing/topup` (invoice ref optional); on admin approval → invoice `paid` +
  grant **the invoice's own tier** via existing `grant-premium {tier: 3|5}`
  (duration never shown to the user — TASK_181 rule). Then **B5** tests + gates +
  deploy (N4 rides B5) → close **C3 + C5** live.
- **B1 ✅ B2 ✅** shipped at `699f119` (8 files, +359/−53; tsc 0 · eslint 0 errors/0
  warnings · 11-suite battery, 585 assertions, 0 fail) — evidence in DONE LOG.

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
- **REMAINING:** ~~A3 → A4 → A5~~ all ✅ → ~~C1 → C5~~ C1/C2/C4 ✅ (C3/C5 partial: API
  e2e live ✅, UI/owner checks ride B1/B2) → B1 → B5. Owner validates Phase A on web
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
- [x] **A5 gates** — tsc 0 · eslint 0-new · `test:module-gate` + `test:xdevice` +
      `test:devices` green · deploy (§2 tar-over-ssh) · live curl 403 free / 200 premium (§4).
      **DONE 2026-10-08:** code gates re-swept green (tsc 0 · eslint = exactly the 8
      proven-pre-existing errors → 0 new · module-gate 13/13 · xdevice 38/38 ·
      devices 6/6 · hosting 338/338 · lab/wallet/deliverability/smtp/message/
      testrecipients/target green). **Deploy §2:** full-tree md5 parity scan
      (637 local vs 631 remote) → 6 local-only (all committed TASK_184 files, e.g.
      `lib/module-gate.ts`, `lib/plan-name.ts`, `components/module-tool-lock.tsx`) ·
      0 remote-only · ~40 content drifts (A1/A2 + naming never deployed) →
      whole-tree tar-over-ssh of `app lib components tests prisma` (§1: rsync 2.6.9
      untrusted) with `--exclude='.env'` → **re-parity DIFF_LINES=0** (md5 both ends)
      → `scripts/deploy-vps.sh /tmp/deploy-root.txt` (root files package.json +
      HOW_WE_MOVE_FAST.md): prisma generate → maintenance ON → build → restart →
      `active` + localhost:3500 → 200 → runtime survived (.env/.next/node_modules/
      static/maintenance.html) → maintenance OFF → done.
      **Live §4:** disposable `scripts/t184-a5-e2e.ts` run ON the VPS (real HTTP +
      real login cookies, self-cleaning, deleted from both ends afterwards) →
      **RESULT: PASS — 15/15**: anon → 401 · free tier-1 → 403 `{error:*_required}`
      on a representative mutation of ALL FOUR modules (extractor · cyberlab ·
      browser · hosting) + GET stays 200 · **tier-3 → same 403s live** · tier-5 →
      200 + DB read-back (region cleared) · free denial wrote nothing (DB read-back,
      region kept) · cleanup deleted all 3 test users. Post-run: service active,
      localhost + https://spaceworker.top = 200. (Learned live: the API error key is
      `error`, not `code` — fixed 6 assertions; the gates themselves were correct on
      the very first run.)

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
      **PARTIAL 2026-10-08:** API-level e2e DONE — live A5 §4 run proved tier-3 →
      same 403s (extractor/browser) on the deployed server; A4 tests cover
      hosting/cyberlab + device 200 positive control + expired flip. REMAINING:
      UI visibility of the lock card + ticket CTA (needs B1/B2) and the owner's
      visual tier-3 web-vs-wrapper check.

## Phase B — ticket-based premium request (no prices on web)

- [x] **B1 strip subscription prices from WEB** (branch on `useWrapperMode()` /
      `sw_wrapper` cookie): `app/dashboard/billing/page.tsx` premium/xdevice quote card →
      WEB "Upgrade to Premium" with NO amount → ticket CTA, WRAPPER keeps price + Subscribe;
      `app/dashboard/settings/page.tsx:56-101` same split. Wallet TOP-UP amounts stay;
      `components/store.tsx` module prices stay. **WRAPPER branch must not regress.**
      ✅ **DONE 2026-10-08 (commit `699f119`)** — billing: `useWrapperMode()` →
      no-payment branch = `UpgradeFlow` (wrapper) / new `PremiumRequestCard` (web:
      zero amounts, ticket CTA); `SpendFlow` wrapper-only; `StatusCardView` keeps
      payment HISTORY on web and its rejected-resubmit becomes `PremiumRequestCard`
      on web vs `UpgradeFlow` on wrapper (`wrapper` prop). settings card: wrapper
      keeps `${xdevicePrice}` Link, web = `SupportTicketButton` (no amount).
      device-console `ToolLockCard`: web never fetches `/api/store/prices`, label
      "Upgrade to Premium XDevice" + ticket CTA; wrapper unchanged (price label +
      billing link). `TopUpFlow` / store module prices / pricing page untouched
      (allowed). **Static audit:** every remaining amount sits inside a
      wrapper-only component, the wrapper ternary, or payment history (allowed by
      decision). `wrapper-carrier` 6/6 + `wrapper-cookie` 6/6 = no wrapper regression.
- [x] **B2 support ticket templates (SCOPED 2026-10-08 — TWO plans)** — NO
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
      ✅ **DONE 2026-10-08 (commit `699f119`)** — new `lib/support-templates.ts` = the
      ONE contract (slugs ↔ categories + tiers, `SUPPORT_TEMPLATE_OPTIONS`,
      `supportTemplateFromSlug()`: absent param → no preselect, unknown-present →
      tier-5 default, `SUPPORT_OPEN_EVENT`) + new `components/support-ticket-cta.tsx`
      (`openSupportTicket()` = `history.replaceState ?template=` + CustomEvent —
      the widget persists in the shell across client navs, so the EVENT is the
      in-page path and `?template=` the full-load path — plus `SupportTicketButton`).
      Widget: template `<select>` above Subject, POST `category`
      (route schema already allowed it — **NO API change**), preselect on mount +
      event listener (2 house `set-state-in-effect` disables, both used). **CTA map:**
      module lock cards → premium-plus (Link → SupportTicketButton;
      `MODULE_UPGRADE_HREF` removed, zero refs anywhere incl. tests) · device
      ToolLockCard on web → premium-xdevice · billing `PremiumRequestCard` →
      product-aware · settings card → premium-xdevice. Admin queue: plan chip row
      (Every plan / Premium Plus / Premium XDevice) → `?category=` (route →
      `listAdminTickets` exact match already existed — **NO backend change**) + plan
      badge on queue rows.
- [x] **B3 admin invoice (MONEY — own commit, after B1/B2 land)** — premium-request
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
      ✅ **DONE 2026-10-08 (money commit `775cfa3`)** — plan recorded pre-edit (B3
      EXECUTION PLAN below) then shipped: schema model + `User.premiumInvoices`
      (Restrict — payment evidence must not die with the account row) · migration
      `20261118000000_task184_premium_invoice` (CREATE TABLE + 2 indexes + FK +
      CLOSED CHECKs on plan/tier — plan is CLOSED deliberately, unlike
      SupportTicket.status: a garbage plan would carry a garbage tier into the
      grant path) · `POST|GET /api/admin/users/[id]/invoices` (tier derived
      SERVER-side from plan — body tier ignored; amount validated finite/>0/≤100000
      or defaulted live from AdminSetting; methods SNAPSHOT `{btc, usdt_trc20,
      usdt_erc20}` at send; **one open invoice per user** → 400 + invoiceId of the
      existing) · `PATCH …/invoices/[invoiceId]` (edit amount and/or plan **only
      while open**, 409 once settled; plan change re-derives tier; methods never
      re-snapshot — destination must not change mid-flight) · new
      `components/admin/user-invoice-cell.tsx` (lazy per-row: invoices +
      `/api/admin/wallets` defaults on expand; plan switch re-prefills until the
      admin touches the amount) · admin UsersTab **Invoice** column (import + th +
      td only — logic stays in the new file). **Migration validated against the
      real local Postgres in ROLLED-BACK transactions:** DDL ok · `plan_check`
      fires · `tier_check` fires · `userId_fkey` fires · zero residue afterwards.
      **Gates:** tsc 0 · eslint 0 problems on all 3 new files (admin-panel 46/46 =
      identical to HEAD) · battery 11 suites / 590 tests / **585 pass / 0 fail**.
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

### B3 EXECUTION PLAN (recorded pre-edit, after context compaction)

**Scope (own MONEY commit): admin SENDS/EDITS the invoice. User-side display + pay +
paid-transition = B4; tests + live e2e = B5.**

**Schema (additive-only, house rule)**
- New `PremiumInvoice { id cuid, userId → User relation, plan String
  ("premium_plus"|"premium_xdevice"), tier Int (3|5), amountUsd Float, status String
  @default("open") ("open"|"paid"), methods Json, createdAt, updatedAt, paidAt DateTime? }`
  + `User.premiumInvoices[]`. STRING not enum (house convention —
  SupportTicket.status / NotificationLog.outcome reasoning).
- Migration `prisma/migrations/20261118000000_task184_premium_invoice/migration.sql` —
  CREATE TABLE + FK + `@@index([userId, status])`. `npx prisma generate` locally
  BEFORE tsc (playbook §3 order: schema → generate → tsc).

**Routes (admin session → 403, grant-premium sibling style)**
- `GET app/api/admin/users/[id]/invoices` — list for the admin form (user-side GET = B4).
- `POST app/api/admin/users/[id]/invoices` — body `{ plan, amountUsd? }`:
  - tier derived SERVER-side from plan (never from body);
  - amount default from `getAdminSettings()` — `webSubscriptionPriceUsd` (Plus) /
    `xdevicePriceUsd` (XDevice); admin-supplied amount validated (finite, >0, ≤100000);
  - `methods` = SNAPSHOT of AdminSetting wallets `{btc, usdt_trc20, usdt_erc20}` at send;
  - **one open invoice per user** → 400 if one exists (edit it instead).
- `PATCH app/api/admin/users/[id]/invoices/[invoiceId]` — re-edit amount and/or plan
  **only while status="open"** (else 409); plan change re-derives tier. (Next slug rule:
  nested `[invoiceId]` under `invoices/` — no sibling dynamic dir, legal.)

**Admin UI (user detail = UsersTab row, where the grant buttons live)**
- New `components/admin/user-invoice-cell.tsx` ("use client"), lazy per-row: GET
  invoices + `/api/admin/wallets` (defaults — same fetch WalletsTab already uses) on
  expand; plan `<select>` (Premium Plus tier 5 / Premium XDevice tier 3); amount input
  **prefilled from live defaults, freely editable**; plan switch re-prefills; open
  invoice → shown + Save (PATCH); ✓ msg per user (grantMsg pattern).
- `admin-panel.tsx` UsersTab: new **Invoice** column after Grant — thead th + td only,
  all logic in the new file (keep the 6.9k file surgical).

**Deliberately NOT in B3:** user billing display + GET, paid-transition + tier grant on
approval (B4); unit tests + static lock + live e2e (B5); support-inbox deep link (B2's
badge already flags plans in the queue; the action lives on the user detail per spec).

**Then:** prisma generate → tsc 0 → eslint 0-new → battery green → **money commit
(-F file)** → steps update → push.

### B1/B2 EXECUTION PLAN (recorded pre-edit, after context compaction)
### B1/B2 EXECUTION PLAN (recorded pre-edit, after context compaction)

**Already verified (do not re-derive):** widget mounts at `components/shell.tsx:91`
(`{!buildTarget && <SupportWidget />}`) → persists across client navs; POST
`/api/support/tickets` schema already accepts `category: z.string().max(40).nullish()`
→ NO API change; admin `listAdminTickets` filters `where.category = category` exact
match (`lib/support/tickets.ts:577-578`) and route already passes `?category=` →
NO backend change for the admin filter; `MODULE_UPGRADE_HREF` /
`UPGRADE_TO_PREMIUM_PLUS` have zero usages outside `module-tool-lock.tsx` and no test
references; settings page is a SERVER component with `wrapper` already resolved
(env + cookie) at the top; device-console `ToolLockCard` fetches `/api/store/prices`
and renders "Subscribe to Premium XDevice — $X" (a web price leak to fix); billing
`subscription` branch = `UpgradeFlow` (no payment) / `StatusCardView` (payment) /
`SpendFlow` above (wallet activation, price) / `TopUpFlow` (stays).

**New files**
- `lib/support-templates.ts` — pure data, no "use client": `SUPPORT_OPEN_EVENT =
  "sw:open-support"`; slugs `premium-plus` ↔ `premium_request_plus` (tier 5) and
  `premium-xdevice` ↔ `premium_request_xdevice` (tier 3); `SUPPORT_TEMPLATE_OPTIONS`
  for the compose select (Technical issue `""` · Billing question `billing_question`
  · the two premium requests); `supportTemplateFromSlug()` — absent `?template=` →
  no preselect, present-but-unknown → premium-plus (B2's documented default).
- `components/support-ticket-cta.tsx` ("use client") — `openSupportTicket(slug)`:
  `history.replaceState` adds `?template=<slug>` then dispatches the event; plus
  `SupportTicketButton` (usable from the server settings page).

**support-widget.tsx** — `category` state (`""` = technical); `<select>` above
Subject in compose; POST body gains `category: category || null`; preselect via
mount-effect reading `window.location.search` (full-load path) AND
`addEventListener(SUPPORT_OPEN_EVENT)` (in-page CTA path — layout persists, so
mount does NOT re-fire on client nav). Sync setState in effects → house
`// eslint-disable-next-line react-hooks/set-state-in-effect`.

**B1 rule: web shows NO subscription quote; the wrapper branch stays byte-identical.**
- billing: `const wrapperMode = useWrapperMode()` → web: hide `SpendFlow`; no-payment
  → new `PremiumRequestCard(product)` (NO $ anywhere; button →
  `openSupportTicket(product === "xdevice" ? "premium-xdevice" : "premium-plus")`);
  `StatusCardView` payment-history rows KEEP (history ≠ quote); rejected-resubmit →
  web `PremiumRequestCard`, wrapper keeps `UpgradeFlow`. `TopUpFlow`, store module
  prices, pricing page untouched (explicitly allowed by B1).
- settings: web → `SupportTicketButton template="premium-xdevice"` with no amount;
  wrapper → current `${xdevicePrice}` Link untouched.
- device-console `ToolLockCard`: `useWrapperMode()` — web: skip the price fetch,
  label "Upgrade to Premium XDevice", CTA → `openSupportTicket("premium-xdevice")`;
  wrapper: today's price + billing link.

**CTA map** — module lock cards → premium-plus (flip Link→SupportTicketButton) ·
device ToolLockCard (web) → premium-xdevice · billing PremiumRequestCard → product-aware ·
settings XDevice card → premium-xdevice.

**admin queue** — second chip row (All / Premium Plus / Premium XDevice) →
`?category=` + premium badge on rows via `isPremiumRequestCategory()`.

**Then:** gates (tsc · eslint 0-new · test battery) → commit B1+B2 (B3 = own money
commit) → steps update + push.

---

## ORDER (binding)
`STEP 0 ✅ → A3 ✅ → A4 ✅ → A5 ✅ → C1 ✅ C2 ✅ C4 ✅ (C3/C5 = B5 deploy + owner live checks) → B1 ✅ B2 ✅ → B3 ✅ → B4 → B5`.
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
- 2026-10-08 A5 ✅ DONE — **code gates re-swept green** (tsc 0 · eslint 0-new = the
  same 8 proven-pre-existing errors · module-gate 13/13 · xdevice 38/38 · devices
  6/6 · full battery green). **Deploy §2:** full-tree md5 parity scan → 6
  local-only (all committed ours) · 0 remote-only · ~40 drifted (A1/A2 + naming
  never went out) → whole-tree tar-over-ssh `app lib components tests prisma`
  `--exclude='.env'` → **re-parity DIFF=0** → `deploy-vps.sh` build half (prisma
  generate → maintenance ON → build → restart → active/200 → runtime survived →
  maintenance OFF). **§4 live e2e ON the VPS: RESULT: PASS 15/15** — anon 401 ·
  free → 403 `{error:*_required}` for ALL FOUR modules + GET open · **tier-3 →
  same 403s on the deployed server** · tier-5 → 200 + DB read-back · denial wrote
  nothing (DB read-back) · 3 test users cleaned · localhost + https://spaceworker.top
  = 200 after. Disposable script deleted from both ends (pre-existing stub kept).
  Note: live API error key is `error` (not `code`) — fixed 6 assertions, gates were
  right on run 1.
- 2026-10-08 **B1+B2 DONE** (commit `699f119`, 8 files, +359/−53, message file
  `/tmp/t184-b1b2-msg.txt`) — evidence on the B1/B2 checkboxes above. **Gates:**
  tsc 0 · eslint 0 errors / 0 warnings on all 8 changed files · battery: module-gate
  13/13 · xdevice 38/38 · devices 6/6 · support 50/50 · browser 8/8 · pages 47/47 ·
  hosting 338/338 · lab 10/10 · wallet 63/63 · wrapper-cookie 6/6 · wrapper-carrier
  6/6 — **0 failures** (585 assertions). **Static B1 audit:** every amount outside
  payment history is wrapper-guarded (verified by grep over the changed files).
  One fix during gates: dropped an unused `set-state-in-effect` disable (the
  `setCategory` inside `applyTemplate`'s useCallback isn't traced by the rule) →
  eslint back to 0 warnings. Incident: the first `cat <<EOF` commit-message write
  garbled/aborted in the interactive terminal (never staged anything) → rewrote the
  message with the editor tool, committed clean. PRE-EXISTING: 8 eslint errors in
  these files at HEAD (proven pre-existing earlier) — none touched.
- 2026-10-08 **B3 ✅ (MONEY, commit `775cfa3`, message file `/tmp/t184-b3-msg.txt`)** —
  PremiumInvoice end-to-end: additive schema model + `User.premiumInvoices` +
  migration `20261118000000_task184_premium_invoice` (validated in ROLLED-BACK txns
  against the real local Postgres: DDL applies · plan_check/tier_check/fkey all fire
  · zero residue) + `GET|POST /api/admin/users/[id]/invoices` + `PATCH …/[invoiceId]`
  (open-only edit, 409 settled, tier derived server-side, one-open-per-user guard,
  payout-address snapshot) + `components/admin/user-invoice-cell.tsx` + admin
  UsersTab Invoice column. Execution plan recorded pre-edit (B3 EXECUTION PLAN).
  **Gates:** tsc 0 · eslint 0 problems on 3 new files / admin-panel 46=46 HEAD ·
  battery 11 suites 590 tests **585 pass 0 fail** (browser 5 skip = baseline).
  NEXT ACTION → **B4** (user pays, both plans).
