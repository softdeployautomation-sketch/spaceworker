# TASK_202 — TELEGRAM-CHIP TRUTH · SIGNUP EMAIL ALERT · BROADCAST EMAIL PACING

Owner asks (2026-10-10): fix admin-UI "Telegram: not connected" (a lie — Telegram
alerts work), add email alert for every new signup, and stop the Resend 429
("only 10 requests per second") that the support broadcast tripped.

## Investigation (before any code) — all three root-caused

### Bug A — chip lies "not connected"
Two chat-id layers exist:
- `env.adminTelegramChatId` (ADMIN_TELEGRAM_CHAT_ID) — what `notifyAdmin()`
  uses; THIS is the working link the owner receives on.
- `AdminNotificationPref.telegramChatId` (DB row, pasted in panel) — what
  TASK_190's per-device fan-out uses; owner never pasted one ⇒ no row.
`admin-shell.tsx` renders "Telegram: not connected → paste chat id" purely from
`toView()`'s `telegramLinked = Boolean(row?.telegramChatId)`. Worse:
`maybeAdminScreenNotify` (admin-notify.ts:211) sends ONLY to the DB chat id —
so with telegram toggle ON and no pasted id, screen alerts silently go nowhere
even though the env link works. env.ts:164 default is "" (not null).

### Bug B — signup alert is telegram-only
`app/api/auth/signup/route.ts:63` → `void notifyAdmin(...)` (telegram, env
chat id). No admin email. `env.adminEmail` is configured (email verified
working for support + admin screen alerts). Route already imports `sendEmail`.

### Bug C — broadcast trips Resend rate limit
Broadcast fan-out sends per-user emails as fast as Resend accepts connections
⇒ 429 "only make 10 requests per second". Every other email path is 1 send per
action; broadcast is the only multi-user fan-out.

## Plan
1. `lib/admin-notify.ts`: `effectiveAdminChatId(row) = row?.telegramChatId ||
   env.adminTelegramChatId || null` (DB paste overrides env; env is the
   always-on fallback). Use in BOTH `toView` (chip truthful) and
   `maybeAdminScreenNotify` (alerts actually deliver). UI consequence: chip
   shows "linked ✓" from the env link and hides the paste form — recorded;
   override still possible via PATCH API.
2. signup route: best-effort admin email after `notifyAdmin`, `to:
   env.adminEmail`, subject "New SpaceWorker signup: <email>", eventType
   "admin_signup_alert" (sendEmail writes its own NotificationLog row);
   contained — an alert failure must never fail the signup.
3. Broadcast: pace the per-user email sends to ≤8/sec (sleep between sends).
   Failures per user already caught+counted; pacing prevents the 429.
4. Tests: admin-notify (env fallback linked-true with no DB row; env chat id
   used as send target; DB paste overrides env), support-broadcast (emails
   paced — recorded send timestamps ≥ min gap), signup (email to adminEmail
   on valid signup; no email when adminEmail unset). Gates: tsc 0 / eslint 0
   / green suites. Then deploy + close.
5. (Same day, screenshot) Broadcast "Announcement" threads flood the ADMIN
   support queue Open list — they're delivery artifacts, not tickets, and
   they bury real customer tickets. Fix: exclude subject "Announcement" from
   the ADMIN list only; the USER keeps seeing their announcement thread (it
   IS the delivery). Marker reuse = the existing premium-request subject
   pattern ("request"/"plus"). Test seeded: announcement + real ticket →
   admin list shows only the real one; user list still shows the
   announcement.

## PROGRESS