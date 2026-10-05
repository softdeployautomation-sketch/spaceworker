# PLAN — Task 162: Store as a multi-select dropdown

**Status: SCOPED, not started.** 2026-10-05.
Owner: *"take out the store prices card, and make it a drop down, i don't like the way the prices
is listed, i want a drop down users can select multiple items."*

## 1. Current shape (verified 2026-10-05)

`components/store.tsx` renders a 3-section grid of `<StoreCard>` — web bundle, then
`kind === "module"`, then `kind === "exe"` (`:78-124`) — and buying is **strictly one product at
a time**: `const [buying, setBuying] = useState<Product | null>(null)` opens a
`CheckoutModal` bound to that single product (`:35`, `:127-129`).

The whole purchase path is single-product, not just the UI:

| Layer | Reality | Cite |
|---|---|---|
| Product catalogue | 4 modules + web bundle + 4 EXEs, each with a `priceField` key into admin settings | `lib/products.ts:70-131` |
| Price source | `settings[product.priceField]` — **server-read, never client** | `app/api/billing/checkout/route.ts:70-72` |
| Checkout request | `?product=<single productId>` → returns **one** `amountUsd` | `app/api/billing/checkout/route.ts:30-79` |
| Submit | body `product?` is a single string | `app/api/billing/submit/route.ts:64-67` |
| Fulfillment | one `Payment.product` → `getProduct(productId)` → one product's `entitlementKeys` | `lib/license-service.ts:45`, `:105-113` |

Modules already grant entitlements per key (`entitlementKeys: ["extractor"]`, `["mailer"]`,
`["assistant","devices"]`, `["hosting"]` — `lib/products.ts:86-131`), and
`grantModuleEntitlements` loops over them (`lib/license-service.ts:79-84`). **So multi-select of
modules is already expressible in the data model** — the work is entirely in pricing, checkout
and fulfillment.

## 2. Design decision: ONE charge for N modules, or N charges?

**Recommended: ONE charge for N modules.** The owner wants a cart-like multi-select, and a
single BTC/USDT transfer cannot be split into N verified on-chain payments.

- Sum the selected modules' **server-read** prices into one `amountUsd`.
- Introduce a **cart product id** (e.g. `modules_cart`) whose fulfillment resolves the
  selection from a server-side record — **never from the client body**, following the existing
  discipline that `durationDays` is "NEVER trusted for the actual charge — re-validated and
  re-priced here independently" (`app/api/billing/submit/route.ts:29-32`).
- The cleanest implementation is a short-lived server-side cart row (or an
  HMAC-signed, expiring cart token) created by `POST /api/billing/cart`, so `submit` re-reads
  the item ids from storage and re-prices them. **Do not** accept `amountUsd` or a bare
  `productIds` array from the browser.

## 3. Phases

- **S1** Server cart: `POST /api/billing/cart` (validate ids against `MODULE_PRODUCTS`, reject
  `web`/`exe` kinds in a cart, price from `getAdminSettings()`, return itemised
  `[{productId, name, amountUsd}]` + total). No schema change if a signed token is used.
- **S2** Dropdown UI: replace the grid in `components/store.tsx` with a multi-select
  dropdown/listbox — checkbox per module, sticky total, `aria-expanded`/`role="listbox"`/
  `role="option"`/`aria-selected`, full keyboard support. Cards for `web`/`exe` stay as they are.
- **S3** Cart-aware checkout: `GET /api/billing/checkout` accepts the cart token; the modal shows
  the itemised breakdown, not one line.
- **S4** Fulfillment: `submit` + `handleApprovedPayment` grant **the union of all** selected
  modules' `entitlementKeys` in one call, once, inside the existing transaction. Guard against
  double-grant (the module grant path is already idempotent by upsert —
  `lib/entitlements.ts` `grantEntitlement`).
- **S5** Tests + wallet interlock: buying from the wallet (W5) must debit once for the whole
  cart, not per item. `lib/wallet.ts` is price-agnostic by design, so this is a caller concern.

## 4. Rules
- **Never trust a client-supplied total.** Re-price server-side in `submit`, mirroring the
  `durationDays` discipline.
- **`web_subscription` stays a separate single-product path** — it is a tier bump, not an
  entitlement set, and mixing it into a cart changes `bumpWebTier` semantics.
- **EXE products may not share a cart with modules.** EXE pricing is duration-computed
  (`calculateExePrice`) and issued as a license with its own term logic.
- Rate-limit `POST /api/billing/cart` like the existing no-session EXE path already is
  (`app/api/billing/submit/route.ts`, Task 52 `allowAndRecord`).
- Full suite green before shipping: tsc, test:hosting 334, test:support 30, test:wallet 29,
  ESLint, `CI=true npm run build`.

## 5. Open for the owner
- Should a cart of N modules show a **combined discount**? (Recurring subscription stacking via
  `grantEntitlement` already extends terms correctly — `lib/entitlements.ts` Task 99 note.)
- Should selecting a module that the user **already holds** be blocked, or allowed as a
  term-extension purchase? Current behaviour: it grants, and stacks time.
