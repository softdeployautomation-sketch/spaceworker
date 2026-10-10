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

### 2026-10-10 — S1 implementation IN FLIGHT (all 4 fixes coded; 1 gate-fix pending)

**Committed already:** plan at `660bfa0` (this file). TASK_200 S1 green + pushed at `b31eeae`
before this task started.

**Fixes implemented (uncommitted working tree):**
- **A** `lib/admin-notify.ts` — `effectiveAdminChatId(row) = row?.telegramChatId ||
  env.adminTelegramChatId || null` (env.ts:164 default `""` handled by `||`);
  used in `toView` (chip truthful: env link counts as "linked ✓", paste form hides —
  recorded trade-off: override then only via PATCH API) AND in
  `maybeAdminScreenNotify` (was: toggle ON + no pasted id ⇒ telegram alerts silently
  went nowhere).
- **B** `app/api/auth/signup/route.ts` — import `env`; module-level `escapeHtml`;
  after `void notifyAdmin(...)`: guarded (`if (env.adminEmail)`) best-effort
  `sendEmail({to: env.adminEmail, subject: "New SpaceWorker signup: <email>",
  eventType: "admin_signup_alert"})` with `.catch(() => undefined)` (sendEmail logs
  its own NotificationLog row in its finally).
- **C** `lib/support/tickets.ts` — `BROADCAST_EMAIL_SPACING_MS = 130` +
  `sleep()` helper; broadcast loop is now index-based with
  `if (i > 0) await sleep(...)` before each user (paces Resend ≤ ~8/s, under its
  10/s hard cap that the live broadcast tripped with "Too many requests").
- **D** `lib/support/tickets.ts` — `BROADCAST_ANNOUNCEMENT_SUBJECT` constant (used
  by the create). **IMPORTANT SEQUENCE:** first attempt put
  `where.subject = { not: ... }` inside `listAdminTickets` — this broke the
  deliberate existing contract in tests/support-tickets.test.ts §4
  ("the empty filter must not reach the query at all" — where must stay `{}` with
  no filters) and the generic fake `matches()` didn't model `{not}` (4 failures:
  not-ok 30/31/37/52). That where clause has been **REVERTED**; the plan is the
  honest in-service POST-FILTER: after `findMany`, drop rows whose subject is
  BROADCAST_ANNOUNCEMENT_SUBJECT BEFORE `map(toTicketView)` — keeps every where
  contract intact. **← THE EXACT NEXT EDIT (not yet applied).**

**Tests extended/created:**
- `tests/admin-notify.test.ts` — fakeEnv typed with `adminTelegramChatId: ""`
  (+ reset in beforeEach); +3 tests (725+): chip linked via env with no DB row &
  id never leaks; fan-out sends to ENV id when none pasted; pasted id overrides env.
  **22/22 GREEN.**
- `tests/admin-signup-alert.test.ts` — NEW, house Module._load pattern, 3 tests:
  admin email goes out (to=admin only, correct subject/eventType, user still gets
  verify+tier1); no adminEmail ⇒ no admin email & user flow intact; Resend failing
  ⇒ still 201 + account created. Script `test:admin-signup-alert` added to
  package.json. **3/3 GREEN.**
- `tests/support-broadcast.test.ts` — emailTimes recorder in notify fake; fake
  supportTicket.findMany (TICKET_LIST_SELECT-shaped rows; userId/status/subject.not
  filters — NOTE: subject.not filter is now dead code after the where revert; keep
  or trim at next touch); service cast + listAdminTickets/listUserTickets; +2 tests:
  C pacing (4 users, every gap ≥100ms) and D queue exclusion (own-goals fixed once
  already: u-x's OPEN ticket means reuse, not an Announcement thread — assertion now
  checks u-free gets ["Announcement"] AND u-x stays ["My install is stuck"]).
  **20/20 GREEN.**

**Gates so far:** tsc **0 errors**; eslint **clean** (6 files, exit 0).

**PENDING (do next, in order):**
1. Apply the listAdminTickets post-filter edit (described in D above).
2. `npm run test:support` → back to **57/57** (the 4 failures were caused by the
   reverted where clause; not-ok 52 "read cursor only moves FORWARDS" is the known
   ms-flake from TASK_192 — confirm it passes on rerun, else isolate like T192 did).
3. Trim/keep the now-dead `subject.not` branch in the broadcast fake (honesty).
4. Re-run: test:admin-notify, test:admin-signup-alert, test:support-broadcast,
   test:premium-request-static; then full `npm run test` battery.
5. **COMMIT S1** (steps + code + tests + package.json) via `/tmp` msg file; push.
6. S2: deploy to VPS (rsync app lib components tests + build + restart), live-verify:
   admin chip reads "Telegram: linked ✓" without a pasted id; make a real test signup
   → admin email arrives; (Resend pacing + announcement exclusion visible in panel).
7. Closeout: AFTER-RECORD, commit, push; then resume TASK_200 S2 (15-min auto-run
   battery history in Health panel, tab-strip wrap to ~3 lines, mailer-EXE plan
   doc TASK_201) per TASK_200_STEPS.md.