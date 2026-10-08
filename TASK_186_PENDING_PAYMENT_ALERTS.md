# TASK_186 — Pending-payment owner alerts + instaweb.top joker page

Owner (2026-10-07), three asks bundled (the third is scoped into TASK_184, not here):

1. **Email + Telegram for any pending payment** — owner confirms manually from
   admin before crediting, so every pending payment must ping them on the usual
   admin routes.
2. **`spaceworker.instaweb.top` must stop serving the app** — it mirrors
   spaceworker.top today; replace it with a static page showing a joker picture
   (owner has other UI plans for that domain later).
3. *(scoped into TASK_184 §Phase C)* tier-3 XDevice subscribers are limited on
   the **web app** exactly like free users — see other tools but locked, ticket
   premium request to unlock.

## Steps

- [x] **S1 research** — usual admin routes found: Telegram = `notifyAdmin()`
      (lib/telegram.ts, fixed `ADMIN_TELEGRAM_CHAT_ID`, used by signups/license
      binds) · Email = `sendEmail()` (Resend, `RESEND_API_KEY` live on box) ·
      `ADMIN_EMAIL` unset on box → env falls back to `EMAIL_FROM`
      (`spaceworker@instaweb.top`) as recipient.
- [x] **S2 `lib/payment-notify.ts`** — `notifyAdminPendingPayment()` — sync,
      fire-and-forget, per-channel best-effort (Telegram + email), message
      carries amount/product/method/hash-visibility/stage/status + admin link,
      `eventType: "admin_pending_payment"`.
- [x] **S3 `lib/env.ts`** — `adminEmail = ADMIN_EMAIL || EMAIL_FROM`.
- [x] **S4 wire `/api/billing/submit`** — alerts at ALL manual-review exits:
      no-hash (hasHash false), USDT-ERC20, chain-pending and flagged at the end.
      Auto-approved payments do NOT ping (nothing to confirm).
- [x] **S5 wire `/api/billing/topup`** — alerts at **order open** (stage
      "opened") and **attach/submit** (stage "attach", hash or no-hash).
- [x] **S6 tests + gates** — `tests/wallet-topup.test.ts`: recording fake
      override + assertions (open → 1 "opened" alert; no-hash attach → 1
      "attach"/hasHash=false). Gates: **tsc 0 · eslint 0 errors · topup 23/23 ·
      wallet 63/63**.
- [ ] **S7 commit + push**
- [ ] **S8 deploy** (deploy-vps.sh) + live check
- [ ] **S9 confirm delivery** — next real pending payment must hit owner
      Telegram; email goes to `EMAIL_FROM` unless owner sets `ADMIN_EMAIL=<their
      real inbox>` in box `.env` (ask owner).
- [ ] **S10 instaweb → joker** — box-only `static/joker.html` (repo `static/` is
      runtime state, never committed — same rule as maintenance.html);
      rewrite `/etc/nginx/sites-enabled/spaceworker.instaweb.top.conf` 443
      block → serve joker for ALL paths (keep ACME + redirect + SSL), drop the
      :3500 proxy/maintenance/browser/api locations; `nginx -t` + reload.
- [ ] **S11 verify** — `curl https://spaceworker.instaweb.top/…` returns the
      joker page (any path), `https://spaceworker.top` still 200.
- [ ] **S12 steps + handoff updated** (this file, SENIOR_HANDOFF if needed).

## Reference

- Ports: app = `127.0.0.1:3500` (nginx frontend.conf proxies spaceworker.top).
- Nginx confs live on box only; local copy of maintenance.html is NOT in repo.
- Joker art = inline SVG (no external image → no hotlink/licensing issues).
