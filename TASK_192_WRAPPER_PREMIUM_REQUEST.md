# TASK_192 — Wrapper EXE request-premium flow = web flow (no price, XDevice only)

## Owner's words (2026-10-09/10, verbatim)

> "also lets also make the request premium flow same on the wrapper exe as it
> is for free users on the web, no need putting the price, when they request I
> just send a invoice with the current price or decide to edit just the way it
> is on the web"

> "we just need to take out the fixed price, and make the payment flow the same
> with the web free, also trying to buy .. but this time, they can only request
> for premiumxdevice not premium plus. support was not removed from the wrapper
> per my instructions"

## Decisions locked with the owner

1. **Support widget STAYS mounted in the wrapper** — confirmed reachable:
   hosted window and the localExe+wrapper branch both render `<Shell>` with
   `buildTarget={undefined}` and `components/shell.tsx:91` gates the widget on
   `!buildTarget` → `<SupportWidget />` mounts (`app/dashboard/layout.tsx:65,89`).
2. **No price anywhere in the wrapper** — the wrapper's priced self-serve
   surfaces become the WEB surface (ticket request → admin sends/edits invoice).
3. **Wrapper can only request Premium XDevice, never Premium Plus** — every
   wrapper request CTA is pinned to the `premium-xdevice` template; the
   support composer's `<select>` must not offer "Request for Premium Plus"
   while in wrapper mode.

## Surfaces that carry a price / Plus today (verified)

| Surface | Today (wrapper) | After |
|---|---|---|
| `app/dashboard/settings/page.tsx` Premium XDevice card | priced `<Link href="/dashboard/billing?product=xdevice">Subscribe…— $X` | same `SupportTicketButton template="premium-xdevice"` as web |
| `components/device-console.tsx` `ToolLockCard` | fetches `/api/store/prices`, label `Subscribe to Premium XDevice — $X`, links to billing | identical to web arm: `SupportTicketButton template="premium-xdevice"` |
| `app/dashboard/billing/page.tsx` subscription branch | `UpgradeFlow` (crypto checkout w/ price) | `PremiumRequestCard` pinned to xdevice |
| billing `SpendFlow` ("Activate with balance", price) | wrapper-only block | removed from wrapper (web never had it) |
| billing `StatusCardView` rejected-resubmit | `UpgradeFlow` in wrapper | `PremiumRequestCard` in wrapper (as web) |
| support composer `<select>` | offers both Plus and XDevice | wrapper mode: Plus option hidden |

Locked by `tests/premium-request-static.test.ts` (B1/C3/N4 sections) — those
assertions get UPDATED in the same commit as the change (they pin the old
wrapper/price split deliberately; the owner has now moved that line).

## Slices

- **S1** — settings card + `ToolLockCard` → web request flow (price fetch and
  `xdevicePrice` interpolation removed) + update B1 static locks.
- **S2** — billing page: wrapper gets `PremiumRequestCard` (xdevice-pinned),
  drop `SpendFlow` wrapper block + rejected-resubmit wrapper arm; keep
  `UpgradeFlow` code only if still referenced, else remove with its dead code.
- **S3** — support composer: hide the Premium Plus option in wrapper mode
  (`useWrapperMode` inside `components/support-widget.tsx`) + tests.
- Gates per slice: `npx tsc --noEmit` · eslint touched files vs baseline ·
  `npm run test:premium-request` (renamed script? no — existing
  `test:premium-request-static`) + `test:xdevice-payment` +
  `test:xdevice-route-gate` + `test:xdevice-tier` regressions.
- Commit + push per slice.

## Acceptance (owner)

In the wrapper EXE: no dollar figure on any premium surface; clicking any
request CTA opens the support widget preselected on Premium XDevice; the
composer cannot select Premium Plus; admin answers with an editable invoice
(exactly the web free-user journey).

## Open question (not blocking)

Billing self-serve (`UpgradeFlow`/`SpendFlow` = crypto checkout and
balance-activate) disappears from the wrapper entirely. Owner said "payment
flow same as web free" — web has no self-serve subscription checkout, so this
is the faithful reading. Server routes (`/api/billing/*`, `/api/wallet/spend`)
stay untouched; only the UI surfaces change.

TASK_192_STEPS.md carries the before-plan and every dated progress entry.