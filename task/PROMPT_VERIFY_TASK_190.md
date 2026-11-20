# PROMPT_VERIFY_TASK_190 — Admin screen-monitor + admin notify channels + owner presence

You are the verifying/closing agent for TASK_190. The implementing agent claims
it is done; your job is to PROVE each behaviour live and fix only what is
broken, following HOW_WE_MOVE_FAST.md to the letter (no stashes, no `.env`
edits, checklist updates after every step, one commit per logical slice,
multiline commit messages via file + `git commit -F`).

Scope + ground truth: TASK_190_STEPS.md. Admin panel root is the SECRET route
`/admin=topsecret6199` (TASK_188) — `/admin` and friends must 404 with zero
redirects/leaks; re-run that gate at the end.

## 0. Pre-flight

- `git log --oneline -5` + `git status --short` — work should be committed per
  slice; the stray `TASK_133_RMM_ENGINE_BRINGUP.md` must NEVER be committed.
- Gates first (fix before touching the server):
  `npx tsc --noEmit` = 0 · eslint on every touched file = 0 ·
  `npm run test:admin-devices` · `admin-notify` · `admin-screen-monitor` ·
  `user-presence` · `admin-users-presence` · `test:devices` · `test:xdevice` ·
  `test:wallet` · `test:module-gate` · `test:maintenance-cache` ·
  then full `npm run test`.
- Schema drift check: `npx prisma migrate status` — expect the TASK_190
  migration (AdminNotificationPref + UserPresenceEvent tables; User.lastSeenAt /
  lastActiveAt / lastSeenPage; Device.adminNotifyEnabled /
  adminNotifyLastSentAt) applied locally. On the VPS it must be applied via
  `prisma migrate deploy` BEFORE the service restart.
- Env needed for S3/S4 live behaviour: `TELEGRAM_BOT_TOKEN`,
  `ADMIN_TELEGRAM_CHAT_ID`, `ADMIN_EMAIL` (or `EMAIL_FROM`), `RESEND_API_KEY`.
  If a var is unset, the UI toggle for that channel must be GREYED OUT (the GET
  `/api/admin/notification-prefs` reports `configured`) — a clickable toggle for
  an impossible channel is a BUG.

## 1. S1+S2 — Actions dropdown + screen-monitor panel (live)

1. Log in at `https://spaceworker.top/admin=topsecret6199/login`.
2. Devices tab → each ACTIVE row's button is now **"Actions ▾"** (not "Remote
   Control"); open the menu: items are **Open console** and **Screen
   monitor…**; Esc and clicking elsewhere close it; the row height has not
   changed; the menu is NOT clipped by the table.
3. "Open console" → lands on `/admin=topsecret6199/device/101`-style deep link,
   200 (or the documented guard) — same target the old button used.
4. "Screen monitor…" → panel shows: Monitoring toggle, cadence + retention
   (read-only), Latest summary (text or the normal "no summary yet" copy —
   NEVER rendered as an error), Notify-admin toggle.
5. Flip Monitoring ON for a device whose owner has monitoring OFF →
   `ssh root@164.68.105.96` → psql/ORM: that Device row's
   `screenshotMonitoringEnabled = true`; an audit row of kind
   `screen_monitor_toggle` exists. Flip back OFF → field false, second audit row.
   The owner's `screenTriggerNotificationsEnabled` /
   `screenDigestEnabled` are UNCHANGED.
6. Deep-404 check (curl with the admin cookie): a deviceId belonging to no user
   → **404** (never 403); a soft-deleted device → **404**; garbage body to PATCH
   → **400**.

## 2. S3 — Admin notification channels (live)

1. Header of the admin panel shows **Notifications [Telegram] [Email]** toggles.
2. GET `/api/admin/notification-prefs` (admin cookie) →
   `{prefs: {notifyEmail, notifyTelegram}, configured: {telegram, email}}`
   matching the env reality.
3. Turn BOTH off → send yourself a test by flipping a device's Notify-admin
   toggle and forcing a summary (or calling the fan-out's test seam) →
   **no** Telegram message, **no** email, and `NotificationLog` gains NO new
   `admin_screen_alert` rows. Turn Telegram ON only → exactly ONE telegram
   NotificationLog row (`userId: null`, channel `telegram`) and zero email rows.
4. PATCH persists across reloads (singleton row in `AdminNotificationPref`).
5. Negative: PATCH without an admin cookie → 401. A Telegram API failure
   (bad token) must not 500 the toggle or the sweep — containment.

## 3. S4 — Per-device admin screen-monitor notifications (live)

1. In the Screen-monitor panel, turn **Notify admin** ON for one monitored
   device (channel Telegram ON, prefs ON).
2. Produce a frame WITH a summary (trigger the internal screenshot sweep the way
   TASK_127/152 docs describe, or use an existing recent summary) → within the
   sweep cycle you receive ONE Telegram message naming the device, owner email,
   capturedAt, the summary text, and the `/admin=topsecret6199/device/{id}` link;
   `NotificationLog` has `eventType = admin_screen_alert`, `userId = null`.
3. Immediately produce ANOTHER summarized frame → **suppressed** (cooldown
   120 min default): no message, no log row; `adminNotifyLastSentAt` unchanged.
4. Frame with `summary = null` (e.g. `summaryError = cap_exhausted`) → never
   notifies, and the capture/summary pass itself is unaffected.
5. Turn Notify admin OFF → next summarized frame sends nothing.
6. Kill the Telegram token (or point it wrong) → sweep still succeeds
   (`summaries` in the sweep response are normal); only the notification fails,
   visibly, in NotificationLog (`outcome = failed`).

## 4. S5 — Owner presence (live)

1. Open the dashboard as a CUSTOMER user (`https://spaceworker.top/dashboard`)
   in a normal tab → within ~60 s the Users tab shows that user **online**
   (green "active"); `User.lastSeenAt` updated; `lastSeenPage` = a dashboard
   route.
2. Leave the tab idle (no mouse/keyboard) for >5 min → chip flips to **idle**
   (amber "idle Xm"); `User.lastActiveAt` is older than `lastSeenAt`. A ping
   storm must NOT create new `UserPresenceEvent` rows while the state is
   steady (transition-only rule) — check the table.
3. Close the tab / sleep the laptop → within ~3 min the chip shows **offline**
   ("offline · last seen …"). Reopen after the gap → a new `login` event row
   appears.
4. Activity log: click the chip → drawer lists the recent events (login/online/
   idle/offline with page + time), max 100 rows / 7-day window.
5. `POST /api/presence` without a session → **401**. With a session → `{ok:true}`
   and two User columns written (no event row when no transition).
6. Devices tab: every row shows the **owner-presence chip under the owner
   email**, visually distinct from the device STATUS column; it agrees with the
   Users tab for the same owner; the device agent status/last-seen columns are
   byte-identical to before (MeshCentral data untouched).
7. Beacon scope: view-source/network on the ADMIN panel → **no** `/api/presence`
   pings (beacon mounts only in `app/dashboard/layout.tsx`).
8. Retention: the daily sweep (existing internal family) deletes
   `UserPresenceEvent` rows older than 90 days — confirm the code path exists
   and is scheduled with the same mechanism its siblings use.

## 5. Regression + security gates (run LAST, on the final tree)

- TASK_188 gate: `/admin`, `/admin/login`, `/admin/device/101` → 404, no
  redirect, no `admin` strings in the build manifest; `/admin=topsecret6199`
  still guards anonymous users with 307→login.
- Devices Deleted subtab unchanged (Recover + run-command only, NO Actions
  dropdown); Users-tab "View devices" hand-off still filters the devices tab.
- Owner-land `/api/settings/screen-notifications` and the owner's Devices-tab
  screenshot UI behave exactly as before (TASK_152 suite green).
- Full `npm run test` green; local-vs-remote file parity for
  app/lib/components/prisma.

## 6. Symptom → fix map (what to look at first)

| Symptom | Likely place |
|---|---|
| Dropdown clipped/overlapping | devices-tab.tsx popover positioning / table wrapper overflow + z-index |
| Owner trigger/digest settings changed after admin toggle | screen-monitor PATCH route writing the wrong fields |
| Summary shown as an error | panel not honouring "no summary is NORMAL" copy rule |
| 403 instead of 404 on foreign/deleted device | route bypassing `assertAdminDeviceAccess` (lib/admin-devices.ts) |
| Telegram works, email doesn't (or vice versa) | env (`ADMIN_EMAIL`/`ADMIN_TELEGRAM_CHAT_ID`) vs `configured` flag wiring in lib/admin-notify.ts |
| NotificationLog rows with a non-null userId for admin sends | admin-notify passing a user id instead of null |
| Presence rows growing per ping | transition dedupe missing in recordUserHeartbeat |
| Users flickering online↔idle on refresh | chip client-derivation windows differ from lib/user-presence.ts constants |
| Admin's own session appearing in presence | beacon mounted in admin layout — remove it |
| Sweep fails when Telegram is down | maybeAdminScreenNotify not wrapped in its own try/catch |
| Presence chip confused with device status | devices-tab OWNER column labelling/styling |

Close out per playbook: AFTER-RECORD in TASK_190_STEPS.md (gates table, deploy
evidence, BUILD_ID before/after, commits), push, then state remaining risks
explicitly — never claim what was not proven.

