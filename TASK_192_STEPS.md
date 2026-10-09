# TASK_192_STEPS — wrapper request-premium flow = web flow

## BEFORE-PLAN (written 2026-10-09, before any code)

1. **S1** — settings card: delete the wrapper priced `<Link>` arm, render the
   web `SupportTicketButton template="premium-xdevice"` unconditionally;
   `ToolLockCard`: delete price fetch/state/label branch, render the same
   button with `Upgrade to Premium XDevice`. Update B1 locks in
   `tests/premium-request-static.test.ts` to the NEW line (no price anywhere,
   ticket CTA everywhere).
   Gates: tsc · eslint touched files · `npm run test:premium-request-static`.
   Commit.
2. **S2** — billing page: wrapper subscription branch → `PremiumRequestCard`
   pinned to xdevice (never web_subscription); remove the wrapper-only
   `SpendFlow` block; rejected-resubmit wrapper arm → `PremiumRequestCard`.
   Remove now-dead code only if unreferenced (else keep — no gratuitous
   deletions). Gates + `test:xdevice-payment` `test:xdevice-route-gate`. Commit.
3. **S3** — support composer in wrapper mode: hide the
   `premium_request_plus` `<option>` via `useWrapperMode()`; add a static test
   asserting the wrapper branch filters it. Gates + commit.
4. Full-suite sanity `npm run test` before closeout; push everything.
5. Progress entry after EVERY step (dated, with proof).

## PROGRESS


### 2026-10-09 12:41 — S1 RESEARCH DONE (exact edit plan locked, NO code yet)

Context state for resumption: TASK_191 DONE+pushed at `65c12ca`; TASK_190
deployed live (owner tested, works — two triage notes recorded in
TASK_190_STEPS: no screenshot viewer; "Open console" reloads page, redundant
with Remote control, deferred). This task file + TASK_191/193 docs pushed at
`bb57a9b`/`65c12ca`.

**S1 findings (reads verified):**
- `components/device-console.tsx` `ToolLockCard` (lines ~395-460): wrapper
  branch = `useWrapperMode` → priceUsd state + `fetch("/api/store/prices")`
  + label `Subscribe to Premium XDevice — $X` + `<Link
  href="/dashboard/billing?product=xdevice">`; web arm already =
  `SupportTicketButton template="premium-xdevice"` label "Upgrade to Premium
  XDevice". `useWrapperMode` import (line 33) + wrapperMode/isWrapper (404-5)
  are used ONLY by this card in this file → removable with the branch.
- `app/dashboard/settings/page.tsx`: line 65 `const xdevicePrice =
  settings.xdevicePriceUsd;` (ONLY use is line 130 inside the wrapper arm);
  lines 125-136 = `wrapper ? <Link…Subscribe…— ${xdevicePrice}> :
  <SupportTicketButton…>Request Premium XDevice</SupportTicketButton>`;
  comments at 59 & 109 mention xdevicePriceUsd → rewrite.
- B1 locks to rewrite in `tests/premium-request-static.test.ts`: settings
  wrapper-arm regex (~line 253) + `xdevicePrice` count===1 (~259) +
  device-console guard/fetch-count/label regexes (~271-291). N4/C3 asserts
  stay.

**S1 edit plan:** settings → unconditional SupportTicketButton (delete
xdevicePrice const + wrapper arm + fix comments); ToolLockCard → delete
wrapperMode/price state/fetch/Link, ONE label + ONE SupportTicketButton,
delete useWrapperMode import; rewrite the three B1 tests to the NEW invariant
(0 price refs in settings, 0 `store/prices` in device-console, ticket CTA
present, wrapper links gone).

**Gates for S1:** `npm run test:premium-static` (existing script) ·
regression `test:xdevice` `test:devices` · `npx tsc --noEmit` · `npx eslint`
touched files → then progress entry + commit via /tmp msg file.


### 2026-10-09 12:45 — S1 DONE: both CTA surfaces price-free + B1 locks rewritten

**Code:**
- `app/dashboard/settings/page.tsx` — wrapper `<Link …billing?product=xdevice>
  Subscribe…— ${xdevicePrice}</Link>` arm DELETED; one unconditional
  `SupportTicketButton template="premium-xdevice"` (label "Request Premium
  XDevice"); `const settings = getAdminSettings()` + `xdevicePrice` removed;
  orphaned `getAdminSettings` import removed (Link still used for /terms);
  both comment blocks rewritten to TASK_192.
- `components/device-console.tsx` `ToolLockCard` — wrapper mode, price
  state, `fetch("/api/store/prices")` and the billing `<Link>` ALL deleted;
  ONE label `"Upgrade to Premium XDevice"` + ONE `SupportTicketButton`;
  orphaned `useWrapperMode` import removed.
- `tests/premium-request-static.test.ts` — the two B1 locks rewritten to the
  NEW line: settings page has 0 `xdevicePrice`/0 `billing?product=xdevice`
  /0 priced wording + ticket CTA present; device-console has 0
  `store/prices` + no `$` label + ticket CTA present. Section header now
  "NO price on ANY build (TASK_192 moved the line…)".

**Proofs:**
- `npm run test:premium-static` → `# tests 15 # pass 15 # fail 0`
- regression `npm run test:xdevice` → `38/38` · `npm run test:devices` → `6/6`
- `npx tsc --noEmit` → `tsc exit:0`
- `npx eslint` 3 touched files → `eslint exit:0`
- other tests referencing `xdevicePriceUsd` (module-store, premium-invoice,
  xdevice-payment) assert SERVER catalog behavior which is intentionally
  untouched — confirmed unaffected by grep.

**Next:** commit S1 → S2 (billing page wrapper arms).


### 2026-10-09 12:55 — S2 DONE: billing page loses every self-serve purchase flow

**Code (`app/dashboard/billing/page.tsx`, 976→719 lines):**
- `UpgradeFlow` (crypto checkout quote) and `SpendFlow` (balance activation)
  DELETED — not gated: no build shows a quote or a price anymore.
- No-payment branch: unconditional `<PremiumRequestCard product={requestProduct} />`
  with `requestProduct = wrapperMode !== null ? "xdevice" : product` — the
  WRAPPER IS PINNED to xdevice (owner: "they can only request for
  premiumxdevice not premium plus"); web keeps ?product= (invoice mapping).
- StatusCardView: `wrapper` ternary removed → rejected resubmit is always the
  request card with `requestProduct`; dead `onResult` prop removed (call-site
  too); labels stay truthful to the payment's own product.
- `setSpendEpoch` bump moved into `handleResult` (WalletBalance still remounts
  on results); orphaned `CheckoutInfo` type deleted; comments rewritten.
- `components/store.tsx` comment: "device-console reads it" → reader gone
  (TASK_192); public catalog route untouched.

**Tests (`tests/premium-request-static.test.ts`):** the two billing B1 locks
INVERTED per plan: (a) zero `UpgradeFlow|SpendFlow` identifiers in stripped
source, zero `wrapperMode ?` ternaries, pin expression present, 2×
PremiumRequestCard; (b) zero `/api/billing/checkout` on the page + invoice
card/`store/prices` asserts kept (region end marker `SpendFlow`→`StatusCardView`);
header bullet 3 rewritten.

**Proofs:**
- `npx tsc --noEmit` → `tsc:0`
- `npx eslint app/dashboard/billing/page.tsx tests/…` → `eslint:0`
  (fixed the 1 NEW warning the deletion created — orphaned `CheckoutInfo`)
- `npm run test:premium-static` → `15/15` · `test:maintenance-cache` → `6/6`
  · `npx tsx --test tests/premium-invoice.test.ts` → `34/34`
  · `npm run test:xdevice` → `38/38` · `npm run test:devices` → fail 0
- repo-wide grep: no live `billing?product` links, `UpgradeFlow|SpendFlow`,
  or UI `store/prices` readers left (only the public route + store page itself).

**Next:** commit S2 → S3 (any remaining wrapper-vs-web purchase surfaces,
then full-suite gates) → deploy → closeout.


### 2026-10-09 13:02 — S3 DONE: wrapper composer can only request Premium XDevice

**Plan item 3 executed verbatim** (support composer filter + static test):

**Code (`components/support-widget.tsx`):**
- `useWrapperMode` imported; inside `SupportWidget`:
  `templateOptions = wrapperMode !== null ? SUPPORT_TEMPLATE_OPTIONS.filter(opt => opt.value !== "premium_request_plus") : SUPPORT_TEMPLATE_OPTIONS`
  — hosted web (null) keeps BOTH request templates, unchanged.
- The composer `<select>` now maps `templateOptions` (filtered), not the raw
  shared constant.
- `applyTemplate` coerces a plus PRESELECT to `premium_request_xdevice` in
  wrapper mode (old `?template=` links / CTA events can no longer file a
  plus request); `useCallback` dep `[wrapperMode]`. Shared module
  (`lib/support-templates.ts`) untouched — its 4-option list is still the
  web contract (B2 test at line 117 unchanged).

**Tests (`tests/premium-request-static.test.ts`):** new S3 lock (test #16):
wrapper context import present · the exact filter-ternary · select maps
`templateOptions` · the coercion expression · shared module still ships
premium-plus for web.

**Proofs:**
- `npx tsc --noEmit` → `tsc:0`
- `npx eslint components/support-widget.tsx tests/…` → `eslint:0`
- `npm run test:premium-static` → `16/16` (+1 S3, 0 fail)
- regression `npm run test:support` → `57/57` (0 fail; suite has no
  widget-source assertions — grep confirmed)

**Next:** progress entry → commit S3 → plan step 4: full-suite
`npm run test` → closeout entry → push.


