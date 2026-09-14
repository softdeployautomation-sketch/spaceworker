# Task 42 — Marketing page redesign + a multi-product "store" (web + 4 EXE tiers)

## 0. Naming — "SpaceWorker OS"

**Decided 2026-09-14**: the product's displayed name becomes **"SpaceWorker OS"**. Scope of this rename, for THIS task: the landing page, the store/pricing page, and the footer/nav built here. Leave the rest of the app (dashboard header, `<title>` tags elsewhere, admin panel, transactional emails) as plain "SpaceWorker" unless the owner separately asks for an app-wide rename — that's a bigger, separate find-and-replace across a live product and shouldn't be bundled into a marketing-page task without being asked for explicitly.

**Status: ready for Cline.** Independent of Tasks 39/40 (different files). Builds on Task 27 Part A's already-decided EXE/licensing architecture (`TASK_27_EXE_LICENSING_AND_AUTOMATIONS_AGENT_PLAN.md`) — read that doc's Part A before starting this one, since this task implements its **checkout/pricing/licensing plumbing now**, while the actual downloadable EXE builds (Tauri shell, ported local mailer/extraction engines, 4 build variants) remain that doc's own separate, later, multi-week workstream. Nothing here builds real installable software.

## The ask, as given (2026-09-13/14)

> i will like the spaceworker marketing page to be redesigned with all i said before and the agent and automation addition, and about the exe and stuff which users will want to buy separately or if they can select all, we put a price or if they just want to sign up to enjoy all benefit. lets have like a store where people can buy any applications, we just list the ones we have

Resolved via AskUserQuestion the same day: **real checkout, fake downloads** — build the full store with real pricing/checkout for both the web subscription and the 4 EXE tiers (using the existing BTC/USDT manual-verification flow), but what's delivered immediately after a purchase is approved is a real, valid, already-active license key — not yet a working download, since the EXE builds don't exist. This is an explicit, accepted business tradeoff (collecting payment before the product is fully ready) — the implementation must be **honest about it**, never implying an instant download that isn't there.

## Visual reference — build against this, don't design from scratch

A static visual mockup of the redesigned landing page (hero, capabilities, the store section, footer) is published here: **https://claude.ai/code/artifact/2ce49c73-865c-4581-a372-28dd6f582fc6** (v2, updated 2026-09-14 with the real "SpaceWorker OS" branding and the real prices below — no more bracketed placeholders) — built from this codebase's actual design tokens (the "Night Studio" warm-amber palette in `app/globals.css`, Sora/Karla fonts from `app/layout.tsx`, the exact Button/Card/Badge treatment from `components/ui.tsx`), not invented from scratch. Match it structurally (section order, the store's 4-tier card layout — no 5th "bundle" card, see item 2) and match the extracted tokens exactly for anything the mockup doesn't spell out — don't reinterpret the brand. Reuse the real `Button`/`Card`/`Badge` components from `components/ui.tsx` in the actual implementation rather than re-styling raw elements — the mockup used inline styles only because it's a static HTML preview outside the Next.js app.

## Why the current landing page can't just be "redesigned"

`app/page.tsx` today is a 58-line placeholder: one hero line, a generic capability grid (private browser / lead extraction / outreach / browser profiles), two links (Sign up / Sign in). No pricing, no agent/automation mention, no store. This is closer to a from-scratch build than an edit.

## 1. Landing page content (`app/page.tsx`, likely split into sections/components)

- **Hero**: reposition around what SpaceWorker actually does now — lead extraction + AI-assisted outreach campaigns, with an agent that can run parts of the workflow for you (Tasks 31/37/38/41's real, shipped capability — "describe what leads you need, review the plan, approve it" is a genuine differentiator, use it).
- **Capabilities section**: keep the existing four, add a fifth covering the agent (chat-driven campaign planning, autonomous deliverability diagnostics, staged proposals) and a sixth covering Automations (scheduled daily runs).
- **The Store section** (new): every product SpaceWorker OS sells, listed together, each with its own price and a buy action:
  1. **Web subscription** — the existing sign-up-and-pay-for-tier-1 flow, reframed as a product card alongside the others rather than the only path in.
  2. **Extractor EXE**, **Mailer EXE**, **Combined EXE**, **Automation-enabled EXE** — the 4 tiers from Task 27 Part A, each its own card: name, one-line description (pull from Part A's own tier descriptions), price, "Buy" button. No separate 5th "bundle" SKU — the Automation-enabled tier (Combined + the AI agent) already IS the complete, top tier; that's the "get everything" option.
- Every EXE card visibly says something like **"Desktop app — license issued instantly, download link emailed once the build is ready"** so the fake-download tradeoff is transparent to a real buyer, not hidden in fine print. This is the ONE thing that must be disclosed pre-purchase — see item 4 for what stays undisclosed until after.

## 2. Pricing — real numbers, decided 2026-09-14

Extend `AdminSettings` (`prisma/schema.prisma`, currently just `planPriceUsd Float @default(9.99)`) with one price field per product, using the owner's actual decided prices as the defaults (still admin-adjustable afterward via the same panel `planPriceUsd` already uses — these are real launch prices, not placeholders to revisit):
```prisma
webSubscriptionPriceUsd Float @default(25)   // /month — replaces planPriceUsd's role for the store's own display; keep planPriceUsd itself for back-compat, see note below
extractorExePriceUsd    Float @default(50)
mailerExePriceUsd       Float @default(50)
combinedExePriceUsd     Float @default(70)
automationExePriceUsd   Float @default(100)  // Combined + the AI agent — the top tier
```
Note: `planPriceUsd` already exists at `9.99` and is what `GET /api/billing/checkout`'s `web_subscription` product reads today — either rename it to `webSubscriptionPriceUsd` and update its `@default` to `25` (cleanest, one field, one migration touching its default), or add the new field and have `web_subscription` read from it instead of `planPriceUsd` (keeps `planPriceUsd` around unused) — prefer the rename, less to maintain. Extend `app/api/admin/wallets/route.ts` (or wherever reads cleanest) and the admin panel UI to show/edit all five prices alongside the existing wallet addresses.

## 3. Checkout — extend the existing BTC/USDT flow with a `product` dimension

**Critical distinction**: `Payment.kind` is the PAYMENT METHOD (`"btc" | "usdt_trc20"`) — do not repurpose it. Add a separate field:
```prisma
model Payment {
  ...
  product String @default("web_subscription") // "web_subscription" | "extractor_exe" | "mailer_exe" | "combined_exe" | "automation_exe"
}
```
(Additive migration, defaulted so every existing row is correctly `"web_subscription"` — the only product that has ever existed.)

- `GET /api/billing/checkout` gains a `product` query param (defaulting to `web_subscription` for back-compat), looks up the matching `AdminSettings` price field instead of always `planPriceUsd`.
- `POST /api/billing/submit` accepts and stores `product` on the created `Payment` row.
- The store's "Buy" buttons on the landing page route into this SAME checkout flow (wallet address + amount + tx-hash submission), just pre-selecting the right product — no new payment rail, no new admin-review UI shape, only a new dimension on the existing one. The landing-page buy flow works for a NOT-YET-signed-up visitor too, per Task 27 Part A's original requirement ("no account required first") — checkout collects an email for delivering the license key/subscription confirmation, creating the account inline if one doesn't exist yet (mirrors how `POST /api/billing/submit` already needs `session` today — extend it to accept an email + create-if-missing path for the EXE-product case specifically, since a subscription purchase can keep requiring an existing session).

## 4. License key issuance — port the EXACT format Lead Extractor Pro already uses

`~/lead-extractor/app/license/generator.py` is the proven, already-in-production format (real customers hold real keys in this exact shape today) — replicate it byte-for-byte in TypeScript so a key issued by SpaceWorker today will validate correctly inside the real EXE once Task 27 Part A eventually builds its validator, with zero reissuance needed:

```
payload = { licensee, plan, issued_at, expires_at, machine_id? | machine_ids? }
payload_json = JSON.stringify(payload) with keys sorted alphabetically (Python's json.dumps(sort_keys=True) — Node needs an explicit sorted-key serializer, plain JSON.stringify does NOT sort keys)
payload_b64 = base64url(payload_json)
signature = hex(HMAC-SHA256(secret, payload_b64))
license_key = `${payload_b64}.${signature}`
```
No `machine_id`/`machine_ids` at issuance time here (per Part A: "no machine_id is bound server-side at issuance time... machine binding, if wanted, happens client-side at first activation inside the EXE itself"). `plan` = the purchased EXE tier's slug.

**`days_valid` = 180 (6 months) — decided 2026-09-14, supersedes Part A's original "one-time perpetual license" note.** This is a real, deliberate business decision, not an oversight: every EXE license is now a 6-month term, not perpetual. **The 6-month term is NOT shown anywhere on the public store/pricing page** (the mockup and item 1 above deliberately show only a price, "once," with no duration) — it's disclosed to the buyer for the first time on the post-purchase license page/email (item 6), after the purchase is already made. Implement exactly this: nothing pre-purchase mentions a term; the license page and delivery email state the 6-month expiry (and the actual `expires_at` date) clearly and unambiguously once the buyer is there. New `lib/exe-license.ts` module, its own signing secret as a new required-in-prod env var (`EXE_LICENSE_SECRET` — never reuse `INTERNAL_BEARER_TOKEN` or any other existing secret for this; a leaked key-signing secret can forge unlimited licenses).

New model to store issued keys:
```prisma
model ExeLicense {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id])
  paymentId   String   @unique
  payment     Payment  @relation(fields: [paymentId], references: [id])
  product     String   // matches Payment.product
  licenseKey  String   @unique
  issuedAt    DateTime @default(now())
}
```

## 5. Wire issuance into the existing approval flow

`app/api/admin/payments/[id]/approve/route.ts` currently unconditionally does `user.update({ tier: 1 })` — the only product that has ever existed. Branch on `payment.product`:
- `"web_subscription"` → today's exact behavior, unchanged.
- Any EXE product → generate the license key via `lib/exe-license.ts` (`expires_at` = now + 180 days per item 4), create the `ExeLicense` row, and do **not** touch `user.tier` unless the owner wants EXE buyers to also get web access bundled in (flag this as an open question in the PR rather than assuming either way).

## 6. Post-purchase UX — honest to the buyer, once they've bought

A new small section on the dashboard (e.g. `app/dashboard/licenses/page.tsx`) listing the user's `ExeLicense` rows: product name, the license key (shown in full — it's theirs, and copyable), issued date, **the real expiry date** (`issuedAt + 180 days`, spelled out plainly — "Valid until <date>", not buried), and a status line: **"Download coming soon — we'll email you the moment the desktop app is ready. Your key is already active and will work immediately once you download."** Send the same two facts (license issued + its real 6-month expiry) as a real transactional email (`lib/email.ts`'s `sendEmail`) the moment the license is issued — this email is the buyer's actual disclosure moment for the term length, so it must state the expiry date in plain language, not fine print. Use the new `notifyUser` dispatcher from Task 39 if that's landed by the time this starts (email channel only makes sense here — Telegram/agent-chat notification for "your license is ready" is a reasonable bonus if trivial to include, skip it if not).

## 7. Privacy Policy — genuinely missing, not just unlinked

Confirmed 2026-09-14: `app/terms/page.tsx` (111 lines, real content, `Last updated: September 2026`) exists and is linked from Settings/signup, but there is **no Privacy Policy page anywhere** — only one incidental mention of "privacy" inside the Terms page's exit-node disclaimer. This app collects and stores genuinely sensitive data (extracted lead contact info, encrypted SMTP mailbox credentials, browser-profile fingerprints, BTC/USDT transaction hashes, and — once Task 39 is used — a linked Telegram chat id), and now takes payment for products (Task 42 itself) before delivering them — a real Privacy Policy is overdue, not optional polish.

Write `app/privacy/page.tsx`, same structure/tone/component pattern as `app/terms/page.tsx` (same header, same `<section>` rhythm, same "Last updated" line, linked from the new footer). Cover, grounded in what this codebase actually does — don't write generic boilerplate:
- What's collected (account email; extracted lead data; SMTP credentials, stored AES-256-GCM encrypted, never sent anywhere but the user's own mailbox provider; browser-profile data; payment tx hashes; Telegram chat id if linked; AI usage attributed via `external_user_id` per Task 27/31's Channelry relay).
- That cold-outreach content and recipient lists are the USER's own data and business responsibility, not SpaceWorker's — mirrors the Terms page's existing "not an anonymity product" framing for the equivalent disclaimer on the sending side.
- Retention (check `app/api/internal/retention-sweep/route.ts` for what's actually auto-deleted today and describe that truthfully, don't invent a policy the code doesn't implement).
- That the BTC/USDT flow never touches card data (no PCI scope) and Telegram linking is opt-in and revocable from Settings.
- A real contact/request-deletion path (an email address — ask the owner which one, or reuse whatever `env.emailFrom`/support contact already exists elsewhere in the app).

## 8. A standalone `/pricing` route

The mockup's store section anchors to `#store` on the homepage — also give it a real `/pricing` route (can render the same store component) so it's linkable/indexable on its own, matching the footer's "Pricing" link in the mockup.

## Explicitly out of scope

- The actual EXE builds, Tauri shell, local licensing gate UI, ported local mailer/extraction engines, machine-id binding/activation flow — all of Task 27 Part A's own remaining scope, unstarted and un-blocked by this task; pick that doc back up separately when ready to actually build the desktop apps.
- Refunds/chargebacks for a license issued before its download exists — not asked for; if the owner wants a refund path for this specific risk, that's a separate decision.
- A full visual redesign of the rest of the dashboard ("we need to style the platform" from Task 41's feedback) — this task is landing-page + store scope only.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean; new migrations applied and `prisma migrate status` clean.
- A test purchase of an EXE tier end-to-end: submit via the store's buy flow → admin approves in `/admin` → confirm a real `ExeLicense` row exists with a key that decodes to the right payload, and that re-deriving the HMAC with the configured secret matches the key's signature (i.e. it's a genuinely valid key by the ported format, not just a random string).
- Confirm a `web_subscription` purchase still bumps `user.tier` exactly as it does today — no regression to the existing, real, already-used subscription path.
- Confirm the licenses page and email both read as honest about the download not existing yet — no wording that implies an immediate download link.
- Confirm the store/pricing page (and every buy button/checkout step before payment) never mentions a license duration — only price. Confirm the license page and delivery email DO clearly state the real 180-day expiry once the purchase is complete, and that the issued key's decoded `expires_at` is genuinely ~180 days out, not effectively-unlimited.
