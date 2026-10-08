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

**NOT in scope:** wrapper/TASK_183 (done), wallet spend flows (already gated
server-side), admin manual grant (works, P5). Web only — the wrapper's
Subscribe→billing path stays as-is (its $500 card is a wrapper feature).

---

## Phase A — lock extractor + cyberlabs + hosting for free users (mirror the devices lock)

- [ ] **A1 inventory** — for each module list pages + mutating API routes and the
      entitlement key that already exists (lib/entitlements.ts ENTITLEMENT_KEYS,
      products.ts): extractor (`/dashboard/extract` + extract APIs), cyberlabs
      (`/dashboard/cyberlabs` + APIs), hosting (`/dashboard/hosting` + APIs).
      Note which routes ALREADY gate (devices pattern: lib/device-gate.ts
      `deviceToolsDenied` → 403 `device_tools_required` / `xdevice_required`).
- [ ] **A2 API gates** — reuse the device-gate pattern per module (either a
      generic `moduleGate(key)` in lib/device-gate.ts style or per-module
      wrappers): every mutating/action route 403s for free tier with the same
      `*_required` reason shape. Read-only list/metadata endpoints stay open
      (free users can SEE the module like they can see devices).
- [ ] **A3 UI locks** — PremiumToolLock-style card (the pattern shipped in
      device-console for toolsLocked) on extractor/cyberlabs/hosting pages:
      feature list + "Upgrade to Premium" button → (Phase B) support ticket.
      Server-side gates are the real protection; UI lock is UX only (§3.1).
- [ ] **A4 tests** — mirror tests/xdevice-route-gate.test.ts: one file covering
      the three modules (403 on action routes, 200 on read routes, tier-3+/5
      pass), + static lock that each page imports the lock component.
- [ ] **A5 gates** — tsc 0 · eslint 0-new · new suite + test:xdevice +
      test:devices (no regression to the devices lock) · deploy · live curl
      403 with free session, 200 with premium session.

## Phase B — ticket-based premium request (no prices on web)

- [ ] **B1 strip prices from web premium copy** — billing page xdevice card,
      any "Subscribe to Premium — $…" / store premium price displays: replace
      with "Upgrade to Premium" CTA (NO amount shown anywhere, per owner).
      Pricing stays admin-only (xdevicePriceUsd remains the internal source;
      the wrapper's own card keeps its number — owner said wrapper sells $500).
- [ ] **B2 support ticket template dropdown** — the support/ticket form gets a
      template `<select>`: default option **"Request for Premium"** (+ room for
      more templates later, e.g. "Technical issue", "Billing question").
      Selecting it prefills subject/body; "Upgrade to Premium" buttons across
      web navigate to the ticket form with `?template=premium` preselected.
- [ ] **B3 admin invoice on user details** — support inbox shows premium
      requests flagged; admin action **"Send invoice"** on the user detail:
      amount (admin-set) + our payment methods (reuse the billing page's
      configured methods list) → invoice record visible to that user.
- [ ] **B4 user pays the invoice** — billing page shows the issued invoice
      (amount, methods, pay CTA) → paying reuses the EXISTING checkout/submit
      webhooks; on approval the existing grant path (handleApprovedPayment /
      grant-premium tier) grants premium. NO new payment rails.
- [ ] **B5 tests + gates + deploy** — invoice lifecycle unit tests (create →
      visible only to owner user → pay → premium granted → invoice settled),
      template dropdown present, price strings GONE from web pages (static
      grep-style lock), full gate battery, live e2e with a test account.

## Phase C — tier-3 (Premium XDevice) behaves like FREE on the web app

Owner (2026-10-07): people who subscribe for XDevice (tier 3) get **one
organization + devices in the wrapper**; on the **web app** they must be limited
exactly like a free user — they can SEE the other tools (extractor, cyberlabs,
hosting, …) but can't ACCESS them, and they request premium through the same
ticket flow as a free user to unlock the web tools. The devices entitlement is
the ONLY thing tier 3 carries on the web.

- [ ] **C1 entitlement audit** — confirm `devices` is tier-3's only live
      entitlement and every other key (extractor/cyberlabs/hosting/web…) stays
      ungranted at tier 3 (they are today — verify, don't assume).
- [ ] **C2 gate alignment** — Phase A's gates must key off "has this module's
      entitlement", NOT off "tier >= N" anywhere; a tier-3 session hitting an
      A2-gated route gets the same 403 + reason as a free user.
- [ ] **C3 premium card on wrapper billing** — tier-3 user opening
      `/dashboard/billing` sees the same "Request for Premium" ticket CTA (B2)
      as free users; the wrapper's own XDevice subscribe flow stays untouched.
- [ ] **C4 tests** — extend A4: tier-3 session asserted against every Phase A
      gate (403) AND allowed on devices routes (200) — the positive control
      that proves we didn't over-lock.
- [ ] **C5 gates + live check** — battery + e2e: tier-3 account on web sees
      locked tools + ticket CTA; same account in wrapper keeps device access.

## Order
Phase A first (locks are pure gate hardening), then C (rides on A's gates),
then B1→B5. Owner validates A on web before B ships.