# PROMPT — CONTINUE TASK_190 (S1→S5 implementation)

You are picking up TASK_190 mid-implementation. Slice ① (schema + migration)
is DONE, pushed, and verified at `e8043fc`. Your job is slices ②-⑤.

## MANDATORY BEHAVIOR RULES (non-negotiable — the owner checks these)

1. **After EVERY completed step** (slice sub-step, file group, test run,
   deploy action) you MUST append a dated PROGRESS entry to
   `TASK_190_STEPS.md` under `## EXECUTION RECORD` — what you did + the proof
   (command output, status code, test count). Context compaction WILL happen;
   that file is the only memory that survives. Never let more than one
   meaningful action pass without recording it.
2. **Follow HOW_WE_MOVE_FAST.md word for word** — read the WHOLE file first.
   Key rules: smallest shippable slice → test → gates → commit+push per slice;
   never claim what you didn't prove; multiline commit messages written to
   `/tmp/<name>-msg.txt` **with the editor tool** and committed via
   `git commit -F` — **NEVER via a shell heredoc**: the interactive terminal
   mangles heredocs (this happened once already this task).
3. `TASK_133_RMM_ENGINE_BRINGUP.md` is a stray file — **NEVER commit it**.
   No stashes. Never edit `.env`. Never batch "create migration + edit schema"
   in one call (slice ① kept this rule — keep the pattern).
4. Pre-existing eslint errors in `admin-panel.tsx` (no-explicit-any etc.) are
   NOT yours to fix — just don't ADD new ones.
5. Before deploy: `npx tsc --noEmit`, eslint on touched files, and ALL of
   `npm run test:admin-devices` + the three new suites must pass. Full
   `npm run test` before the deploy (long — run it in background, check exit).

## READ ORDER (before any code)

1. `HOW_WE_MOVE_FAST.md` (whole)
2. `TASK_190_STEPS.md` (whole — BEFORE plan, slice-① PROGRESS with proof, the
   EOF-insert mishap lesson, the S1 ground-truth correction, the open Telegram
   decision)
3. `PROMPT_VERIFY_TASK_190.md` (the acceptance checklist you run at the end)
4. The code files listed per slice below.

## STARTING STATE (proven, not assumed)

- HEAD `e8043fc`: `prisma/schema.prisma` has `User.lastSeenAt/lastActiveAt/
  lastSeenPage`, `Device.adminNotifyEnabled/adminNotifyLastSentAt`, models
  `AdminNotificationPref` (singleton id) + `UserPresenceEvent`; migration
  `prisma/migrations/20261120000000_task190_admin_notify_presence/` matches it.
  Client regenerated + runtime-verified. **The VPS has NOT been migrated yet** —
  `npx prisma migrate deploy` runs during the slice-⑤ rollout, BEFORE the build.
- Admin panel lives at `app/admin=topsecret6199/` (TASK_188 S6 rename); the
  devices page is the secret `/admin=topsecret6199/device/[id]` (no links to it).

## SLICE ② — S1+S2: Actions dropdown + per-device Screen monitor panel

- `components/admin/devices-tab.tsx` (~1319 lines): the row's **"Remote
  control" button (lines ~620-637) is the SILENT VIEWER** (`openRemote` →
  `AdminRemoteViewer`), NOT the console deep link. Replace it with an
  "Actions ▾" dropdown, three items, same styling family as the existing
  row buttons: `Remote control` (calls `openRemote`, keeps the `remoteBusy`
  state), `Screen monitor…` (toggles a new inline panel below the row —
  reuse the expanded-row `<tr>` pattern used by "Command"), and
  `Open console` (`window.open("/admin=topsecret6199/device/" + device.id)`).
  Close the menu on outside click (document click in a `useEffect`).
- New routes (both assert `getAdminSession()` themselves, 403 without; use
  `assertAdminDeviceAccess` from `lib/admin-devices.ts` so an unknown or
  soft-deleted device is a deep 404, mirroring the restore route):
  - `GET /api/admin/devices/[deviceId]/screen-monitor` →
    `screenshotMonitoringEnabled`, `screenshotIntervalMinutesOverride`,
    `screenshotWakeDelayMinutes`, `tier`, plus the latest summarized
    `DeviceScreenshot` (status "captured", `summary` not null, newest first:
    `{summary, summarisedAt, imagePurgedAt}` or null).
  - `PATCH …/screen-monitor` body `{enabled:boolean}` → flips ONLY
    `Device.screenshotMonitoringEnabled` + `recordAgentActionAudit`
    (`approvalChannel:"admin"`, `initiatingChannel:"api"`,
    `action:"admin_screen_monitor"`) on the OWNER's user id. Never touches
    the owner's trigger/digest switches. 400 with clear text if the device
    is soft-deleted ("recover it first").
- Add lib helpers (get/set) to `lib/admin-devices.ts` so routes stay thin.
- Tests: `tests/admin-screen-monitor.test.ts` using the EXACT pattern of
  `tests/admin-devices-secret.test.ts` (Module._load patching, fake db,
  `loadFresh`, fake NextResponse, static fs assertions). Cover: 401/403;
  deep-404 for unknown + removed device; PATCH writes ONLY the two fields;
  GET deep-404; static: dropdown has 3 items, no new links to the secret
  console path. Add `"test:admin-monitor": "tsx --test tests/admin-screen-monitor.test.ts"`.

## SLICE ③ — S3+S4: admin notify channels + per-device admin alerts

- `lib/admin-notify.ts` (new, `import "server-only"`): `getAdminNotifyPrefs()`
  (missing row = both channels OFF), `setAdminNotifyPrefs({telegramEnabled?,
  emailEnabled?, telegramChatId?})` (chat id WRITE-ONLY, numeric-string
  validated, never returned by GET), and `maybeAdminScreenNotify(deviceId,
  frameSummary, now)` — per-device claim-then-send, 120-min cooldown on
  `Device.adminNotifyLastSentAt` (same conditional-`updateMany` claim pattern
  as `claimFiring` in `lib/screen-notifications.ts:136-162`; reuse
  `cooldownElapsed`). Fan-out: email via `sendEmail({to, subject, html,
  eventType:"admin_screen_alert"})` (throws on failure, logs its own
  NotificationLog); Telegram via `sendTelegramMessage(chatId, text)` gated by
  `telegramConfigured()`; admin-path log rows use
  `writeNotificationLog({userId: null, …})` — admin is not a User row.
- Hook: `app/api/internal/screen-notify-sweep/route.ts` — after the trigger
  pass, run the admin pass in ITS OWN try/catch (must not fail the sweep):
  devices with `adminNotifyEnabled:true` AND a summarized frame newer than
  `adminNotifyLastSentAt ?? epoch`, newest summarized frame per device.
- `GET/PATCH /api/admin/notification-prefs` (admin session; GET returns
  `{telegramEnabled, emailEnabled, telegramLinked:boolean}` — never the chat
  id). `components/admin/admin-shell.tsx` header: two compact toggles + a
  small "Telegram: not connected → paste chat id" input (the recommended
  paste-chat-id design; if implemented, FIX the AdminNotificationPref schema
  comment to match — docs must not claim the bot webhook stamps it).
- Tests: `tests/admin-notify.test.ts` — prefs default-off on missing row;
  GET never leaks chatId; PATCH validates numeric chat id; cooldown suppresses
  a second send inside 120 min, allows after; telegram failure doesn't throw;
  sweep hook failure contained. Script `test:admin-notify`.

## SLICE ④ — S5: owner presence (beacon + admin reads + UI)

- `lib/user-presence.ts`: constants ONLINE_WINDOW_S=90, IDLE_WINDOW_S=300;
  `derivePresence(lastSeenAt, now)` (pure — unit-testable); `heartbeat(userId,
  page, now)` — updates `lastSeenAt/lastActiveAt/lastSeenPage`, derives the
  previous state, writes a `UserPresenceEvent` ONLY on transition ("online" /
  "idle" / "offline"; the login route can stamp "login", and the first
  heartbeat after a cold start may be recorded as "login"); `stampLogout`
  for the logout path; `listUserPresenceEvents(userId, limit)`; and a
  retention helper called by `app/api/internal/retention-sweep/route.ts`
  (delete events older than 90 days, own try/catch, log the count).
- `POST /api/presence` (customer route): `getCurrentUser()` from
  `lib/session-user.ts` (401 unauth), body `{page?:string}` (truncate to
  ~120 chars), calls `heartbeat`, returns `{ok:true}`.
- `components/presence-beacon.tsx` ("use client"): pings `POST /api/presence`
  with `usePathname()` on mount + every 60s, plus an immediate ping on
  `visibilitychange`→visible, and `navigator.sendBeacon` on `pagehide`
  (fire-and-forget logout-ish stamp is NOT required — keep it a plain ping).
  Mount ONLY in the HOSTED branch of `app/dashboard/layout.tsx` (inside the
  bottom `<Shell>` return) — NEVER in the localExe branches (no DB there).
- Admin reads:
  - Extend `GET /api/admin/users` (currently id+email only) with `presence`
    (derived from `lastSeenAt`) + `lastSeenPage`.
  - New `GET /api/admin/users/[id]/presence` → last 100 events
    (`state,page,createdAt`), 404 for unknown user.
  - `listAdminDevices` in `lib/admin-devices.ts`: add `ownerPresence` to every
    row (select the OWNER's `lastSeenAt` in ADMIN_DEVICE_SELECT, derive) —
    labelled in the UI as OWNER presence, visually distinct from the device
    Status column.
- UI: UsersTab (`app/admin=topsecret6199/(protected)/admin-panel.tsx`, starts
  ~line 388; `AdminUser` type at line 15 — add `presence`/`lastSeenPage`;
  **read the thead around lines 470-560 BEFORE editing**): presence chip
  column (green/amber/grey with the existing emerald/zinc classes) + chip
  click opens a small activity drawer (fetches the presence route, newest
  first). devices-tab Owner column: small presence dot + tooltip under the
  email button. No polling timers beyond existing loads.
- Tests: `tests/user-presence.test.ts` — `derivePresence` boundaries (89s
  online, 91s idle, 301s offline, null → offline); heartbeat writes an event
  only on transition (fake db counts creates); retention deletes only >90d;
  static: beacon mounted only in the hosted branch, `/api/presence` asserts
  getCurrentUser. Script `test:admin-presence`.

## SLICE ⑤ — gates, deploy, verify, closeout

- Gates: `npx tsc --noEmit`; eslint on EVERY touched file;
  `npm run test:admin-devices` + the 3 new suites; then full `npm run test`
  (background, verify exit).
- Deploy (VPS `root@164.68.105.96`, `/opt/spaceworker`), in this order:
  ① rsync changed `app/ lib/ components/ prisma/ package.json package-lock.json`
  (exclude `.next node_modules .env* TASK_* *.md` — the TASK_188 procedure);
  ② `npx prisma migrate deploy` (applies 20261120000000_task190…);
  ③ `npm run build`; ④ `systemctl restart spaceworker.service`; ⑤ curl checks.
- Run `PROMPT_VERIFY_TASK_190.md` end-to-end on the live site; fix failures
  per its symptom→fix map; re-run the affected suite.
- Closeout: AFTER record in `TASK_190_STEPS.md`, checklist ticks, closeout
  commit, push. Commit sizes: ② lib+routes+devices-tab+tests · ③ lib+prefs+
  header+sweep+tests · ④ presence lib+beacon+admin reads+UI+tests · ⑤ docs.

## KEY API FACTS (verified this session — trust these, re-read files if unsure)

- `sendEmail({to, subject, html, eventType})` — lib/email.ts:55, throws on
  failure, logs its own NotificationLog row.
- `sendTelegramMessage(chatId, text)` + `telegramConfigured()` — lib/telegram.ts.
- `writeNotificationLog({userId, eventType, channel, recipient, outcome,
  errorMessage?})` — lib/notification-log.ts (admin rows: userId null).
- `recordAgentActionAudit({userId?, action, status, initiatingChannel?,
  approvalChannel?, sourceDeviceId?, detail?})` — lib/devices.ts:191.
- `getAdminSession()` — lib/admin-auth (routes assert it THEMSELVES).
- `getCurrentUser()` — lib/session-user.ts:17. `db` (lib/db.ts) vs `prisma`
  (lib/prisma.ts) — lib modules use `db` from "./db"; tests stub "./db" by
  parent filename. `cooldownElapsed` exported at screen-notifications.ts:81;
  `escapeHtml` + `env.appBaseUrl` also there/in lib/env.
- DeviceScreenshot: status "captured", `summary`, `summarisedAt`,
  `imagePurgedAt`, `triggerEvaluatedAt`; model at schema ~2670.
- Test runner: `tsx --test tests/x.test.ts`; pattern:
  tests/admin-devices-secret.test.ts (Module._load patch + fake db +
  loadFresh + static fs assertions).


