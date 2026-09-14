# Task 42 — Marketing page redesign + a multi-product "store" (web + 4 EXE tiers)

**Status: ready for Cline.** Independent of Tasks 39/40 (different files). Builds on Task 27 Part A's already-decided EXE/licensing architecture (`TASK_27_EXE_LICENSING_AND_AUTOMATIONS_AGENT_PLAN.md`) — read that doc's Part A before starting this one, since this task implements its **checkout/pricing/licensing plumbing now**, while the actual downloadable EXE builds (Tauri shell, ported local mailer/extraction engines, 4 build variants) remain that doc's own separate, later, multi-week workstream. Nothing here builds real installable software.

## The ask, as given (2026-09-13/14)

> i will like the spaceworker marketing page to be redesigned with all i said before and the agent and automation addition, and about the exe and stuff which users will want to buy separately or if they can select all, we put a price or if they just want to sign up to enjoy all benefit. lets have like a store where people can buy any applications, we just list the ones we have

Resolved via AskUserQuestion the same day: **real checkout, fake downloads** — build the full store with real pricing/checkout for both the web subscription and the 4 EXE tiers (using the existing BTC/USDT manual-verification flow), but what's delivered immediately after a purchase is approved is a real, valid, already-active license key — not yet a working download, since the EXE builds don't exist. This is an explicit, accepted business tradeoff (collecting payment before the product is fully ready) — the implementation must be **honest about it**, never implying an instant download that isn't there.

## Why the current landing page can't just be "redesigned"

`app/page.tsx` today is a 58-line placeholder: one hero line, a generic capability grid (private browser / lead extraction / outreach / browser profiles), two links (Sign up / Sign in). No pricing, no agent/automation mention, no store. This is closer to a from-scratch build than an edit.

## 1. Landing page content (`app/page.tsx`, likely split into sections/components)

- **Hero**: reposition around what SpaceWorker actually does now — lead extraction + AI-assisted outreach campaigns, with an agent that can run parts of the workflow for you (Tasks 31/37/38/41's real, shipped capability — "describe what leads you need, review the plan, approve it" is a genuine differentiator, use it).
- **Capabilities section**: keep the existing four, add a fifth covering the agent (chat-driven campaign planning, autonomous deliverability diagnostics, staged proposals) and a sixth covering Automations (scheduled daily runs).
- **The Store section** (new): every product SpaceWorker sells, listed together, each with its own price and a buy action:
  1. **Web SaaS subscription** — the existing sign-up-and-pay-for-tier-1 flow, reframed as a product card alongside the others rather than the only path in.
  2. **Extractor EXE**, **Mailer EXE**, **Combined EXE**, **Automation-enabled EXE** — the 4 tiers from Task 27 Part A, each its own card: name, one-line description (pull from Part A's own tier descriptions), price, "Buy" button.
  3. **All-access bundle** — one price covering all 4 EXE tiers (and optionally the web subscription too — Cline's call on whether to fold web in or keep it separate; note the choice in the PR description either way).
- Every EXE card visibly says something like **"Desktop app — license issued instantly, download link emailed once the build is ready"** so the fake-download tradeoff is transparent to a real buyer, not hidden in fine print.

## 2. Pricing — a real, admin-adjustable number per product, not hardcoded

Extend `AdminSettings` (`prisma/schema.prisma`, currently just `planPriceUsd Float @default(9.99)`) with one price field per product:
```prisma
extractorExePriceUsd  Float @default(49)
mailerExePriceUsd     Float @default(49)
combinedExePriceUsd   Float @default(79)
automationExePriceUsd Float @default(129)
allAccessBundlePriceUsd Float @default(199)
```
(Defaults are placeholders — real numbers are a business decision for the owner to tune post-launch via the same admin panel `planPriceUsd` already uses, per Task 27 Part A's own note that pricing "is a pure business number to set at launch, not an engineering decision.") Extend `app/api/admin/wallets/route.ts` (or wherever reads cleanest — it already owns `planPriceUsd`) and the admin panel UI to show/edit all five alongside the existing wallet addresses and web price.

## 3. Checkout — extend the existing BTC/USDT flow with a `product` dimension

**Critical distinction**: `Payment.kind` is the PAYMENT METHOD (`"btc" | "usdt_trc20"`) — do not repurpose it. Add a separate field:
```prisma
model Payment {
  ...
  product String @default("web_subscription") // "web_subscription" | "extractor_exe" | "mailer_exe" | "combined_exe" | "automation_exe" | "all_access_bundle"
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
No `machine_id`/`machine_ids` at issuance time here (per Part A: "no machine_id is bound server-side at issuance time... machine binding, if wanted, happens client-side at first activation inside the EXE itself"). `plan` = the purchased EXE tier's slug. `days_valid` = effectively unlimited per Part A's "one-time perpetual license" decision (e.g. `36500` days). New `lib/exe-license.ts` module, its own signing secret as a new required-in-prod env var (`EXE_LICENSE_SECRET` — never reuse `INTERNAL_BEARER_TOKEN` or any other existing secret for this; a leaked key-signing secret can forge unlimited licenses).

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
- Any EXE product (including the bundle) → generate the license key(s) via `lib/exe-license.ts`, create the `ExeLicense` row(s) (the bundle issues one key per of the 4 tiers, or one key whose `plan` covers all — Cline's call, document the choice), and do **not** touch `user.tier` unless the owner wants EXE buyers to also get web access bundled in (flag this as an open question in the PR rather than assuming either way).

## 6. Post-purchase UX — honest, not deceptive

A new small section on the dashboard (e.g. `app/dashboard/licenses/page.tsx`) listing the user's `ExeLicense` rows: product name, the license key (shown in full — it's theirs, and copyable), issued date, and a clear status line: **"Download coming soon — we'll email you the moment the desktop app is ready. Your key is already active and will work immediately once you download."** Also send this same message as a real transactional email (`lib/email.ts`'s `sendEmail`) the moment the license is issued, using the new `notifyUser` dispatcher from Task 39 if that's landed by the time this starts (email channel only makes sense here — Telegram/agent-chat notification for "your license is ready" is a reasonable bonus if trivial to include, skip it if not).

## Explicitly out of scope

- The actual EXE builds, Tauri shell, local licensing gate UI, ported local mailer/extraction engines, machine-id binding/activation flow — all of Task 27 Part A's own remaining scope, unstarted and un-blocked by this task; pick that doc back up separately when ready to actually build the desktop apps.
- Refunds/chargebacks for a license issued before its download exists — not asked for; if the owner wants a refund path for this specific risk, that's a separate decision.
- A full visual redesign of the rest of the dashboard ("we need to style the platform" from Task 41's feedback) — this task is landing-page + store scope only.

## Verification expected

- `npx tsc --noEmit` / `npm run build` clean; new migrations applied and `prisma migrate status` clean.
- A test purchase of an EXE tier end-to-end: submit via the store's buy flow → admin approves in `/admin` → confirm a real `ExeLicense` row exists with a key that decodes to the right payload, and that re-deriving the HMAC with the configured secret matches the key's signature (i.e. it's a genuinely valid key by the ported format, not just a random string).
- Confirm a `web_subscription` purchase still bumps `user.tier` exactly as it does today — no regression to the existing, real, already-used subscription path.
- Confirm the licenses page and email both read as honest about the download not existing yet — no wording that implies an immediate download link.
