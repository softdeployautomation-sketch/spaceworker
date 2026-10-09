# TASK_190 — Admin screen-monitor actions + admin notify channels + owner presence

Status: **IN PROGRESS — slice ① (schema+migration) DONE + pushed at `e8043fc`.**
NEXT AGENT: start from **`PROMPT_CONTINUE_TASK_190.md`** (full continuation
prompt: mandatory rules, per-slice instructions, verified API facts) and
continue with slice ②. Keep updating THIS file after every step.

## EXECUTION RECORD (compaction insurance — update after EVERY step)

### BEFORE (written before first edit)
- **STARTING POINT:** HEAD `455d2c1` (this scope doc + PROMPT_VERIFY_TASK_190.md
  pushed). Working tree clean except stray `TASK_133_RMM_ENGINE_BRINGUP.md`
  (**NEVER commit**) and old non-ours `stash@{0}` (leave untouched).
- **HOUSE RULES in force:** HOW_WE_MOVE_FAST.md — no stashes, no `.env` edits,
  never batch-create+edit migration files in one call, multiline commit msgs via
  `/tmp/<name>-msg.txt` + `git commit -F`, UI commits separate from money code,
  checklist updated after every step, never claim what wasn't proven.
- **ORDER OF ATTACK:** ① schema migration first (routes depend on the columns):
  `AdminNotificationPref` + `UserPresenceEvent` tables, `User.lastSeenAt` /
  `lastActiveAt` / `lastSeenPage`, `Device.adminNotifyEnabled` /
  `adminNotifyLastSentAt` — one migration, `prisma migrate dev` locally, apply on
  VPS with `migrate deploy` at rollout. ② S1+S2 devices-tab dropdown +
  screen-monitor GET/PATCH routes + panel + `tests/admin-screen-monitor.test.ts`.
  ③ S3+S4 `lib/admin-notify.ts` + prefs routes + header toggles +
  `maybeAdminScreenNotify` sweep hook + `tests/admin-notify.test.ts`.
  ④ S5 `lib/user-presence.ts` + `/api/presence` + beacon in dashboard layout +
  admin reads (users list, users/[id]/presence, devices ownerPresence) + UsersTab
  chips/drawer + devices-tab owner chip + presence tests. ⑤ Gates (tsc, eslint
  touched files, test:admin-devices + 4 new suites + full `npm run test`).
  ⑥ Deploy per §4 → live verify PROMPT_VERIFY_TASK_190.md → AFTER record →
  commits pushed (slice-sized).
- **COMMIT PLAN:** `① TASK_190 schema migration` · `② TASK_190 S1/S2 …` ·
  `③ TASK_190 S3/S4 …` · `④ TASK_190 S5 …` · closeout docs commit.
- **KNOWN RISKS to watch during implementation:** dropdown clipping by table
  overflow; `assertAdminDeviceAccess` must be used by BOTH new device routes
  (deep 404); admin NotificationLog rows must keep `userId: null`; beacon ONLY
  in dashboard layout; presence writes transition-only; sweep hook in its own
  try/catch; the repo's pre-existing eslint errors in admin-panel.tsx (don't fix,
  don't add new).

### PROGRESS — slice ① DONE (schema + migration), verified 2026-10-09
- **Schema edits landed** in `prisma/schema.prisma`:
  - User: `lastSeenAt` / `lastActiveAt` / `lastSeenPage` (right after
    `screenDigestIntervalMinutes`), plus relation `userPresenceEvents
    UserPresenceEvent[]` beside `notificationLogs`.
  - Device: `adminNotifyEnabled` + `adminNotifyLastSentAt` (right after
    `screenshotOnlineSinceAt`, before the TASK_128 `removedAt` block).
  - EOF: new `AdminNotificationPref` (singleton, `@default("singleton")`) and
    `UserPresenceEvent` models under the TASK_190 header comment.
- **MISHAP + REPAIR — read this so it never repeats:** the EOF insert used
  `insert_line` computed from a PRE-edit line count, but the three other schema
  edits in the same batch had already added +20 lines — so the block landed
  INSIDE the `PremiumInvoice` model and split it in half (prisma validate
  reported 8-10 errors). Repaired with ONE replacement edit: PremiumInvoice's
  tail (`createdAt`…`payments`) restored first, then the TASK_190 models
  appended after it. LESSON: after parallel edits, never trust a stale line
  count for `insert_line` — re-read the file tail and anchor on text instead.
- **Migration created** (separate call from schema edits, house rule):
  `prisma/migrations/20261120000000_task190_admin_notify_presence/migration.sql`
  — additive-only; matches the schema EXACTLY (no extra indexes/checks).
- **PROOF:** `npx prisma validate` → "The schema at prisma/schema.prisma is
  valid 🚀"; `npx prisma generate` → ✔ Generated Prisma Client (v6.19.3);
  runtime `node -e require('@prisma/client')` → `Prisma.ModelName.AdminNotificationPref`
  + `UserPresenceEvent` present, `lastSeenPage` ∈ UserScalarFieldEnum,
  `adminNotifyEnabled` ∈ DeviceScalarFieldEnum (AP=… UPE=… userCols=true
  devCols=true). NOTE: earlier greps against `node_modules/.prisma/client/*`
  showed 0 and were misleading — the ModelName/scalar-enum check above is the
  authoritative one.
- **Tree at this point:** `M TASK_190_STEPS.md`, `M prisma/schema.prisma`,
  `?? prisma/migrations/20261120000000_task190_admin_notify_presence/`,
  `?? TASK_133_RMM_ENGINE_BRINGUP.md` (stray — **NEVER commit**).

### GROUND-TRUTH CORRECTION to the S1 scope (from implementation reads)
- The row's current **"Remote control" button is the SILENT VIEWER**
  (`openRemote` → `AdminRemoteViewer` iframe with a minted single-use
  MeshCentral session) — NOT the `/device/101` deep link. So the S1 dropdown
  gets **three** items: `Remote control` (existing silent viewer, same
  behavior/busy state), `Screen monitor…` (S2 panel), `Open console`
  (`window.open("/admin=topsecret6199/device/" + deviceId)`).

### OPEN DECISION for the next agent — admin Telegram chat-id linking
- Schema comment currently claims the admin's `telegramChatId` is "stamped by
  the owner-side bot-linking webhook" — but that flow resolves
  `User.telegramLinkToken` only, and the admin is NOT a User row. Two options:
  (a) add `telegramLinkToken` to AdminNotificationPref via a tiny second
  migration + extend the bot webhook (more moving parts), or
  (b) **recommended: paste-chat-id** — admin header offers a "Telegram" toggle;
  when prefs have no chat id yet, a small input asks for the numeric chat id
  (from @userinfobot), PATCH validates it's a numeric string, stores it, and
  it is NEVER rendered back (write-only). Zero extra schema. If (b) is chosen,
  UPDATE the AdminNotificationPref schema comment to match (comment-only edit,
  no migration needed) — house rule: docs must not claim what code doesn't do.


Admin surface context: the SECRET admin panel lives at
`/admin=topsecret6199` (TASK_188 — never resurrect `/admin` paths anywhere).

## 0. Why / what the owner asked for (verbatim intent)

1. On the secret admin devices page, replace the single "Remote Control" button
   per row with an **Actions dropdown** so the admin can act on a device without
   opening `/device/101`: notably a **Screen monitor** panel where screen
   monitoring + summaries can be turned on/off, "just the way it is in each
   user's tab".
2. The admin gets the resulting screen-monitor notifications on **their own
   Telegram and email** ("the notification on each one i set"), and can turn
   each channel on/off from the admin UI.
3. In the admin **Users** tab, see each user's **presence on the platform**
   (active / idle / offline, derived from when the user's web session last
   connected) plus an **activity log** per user.
4. On the admin **Devices** rows, show the **owner's** presence (online / idle /
   offline) in real time — explicitly DIFFERENT from the device agent's own
   status/last-seen, which already exists.

## 1. Ground truth (verified 2026-10-09 — trust these; re-grep only if a name moved)

### Screen monitor, owner-land (TASK_127 + TASK_152 — DO NOT REBUILD)
- `Device.screenshotMonitoringEnabled Boolean @default(false)` — per-device
  master opt-in (prisma/schema.prisma ~line 1915). Global knobs on the settings
  model (~line 388): `screenshotCaptureIntervalMinutes` (cadence, default 60),
  `screenshotRetentionDays`, `screenshotSummaryMaxCallsPerDevicePerDay`.
- Frames = `ScreenshotFrame` with AI `summary` / `summaryError` / `summaryModel` /
  `summarisedAt` (~line 2675). "A captured frame with no summary is NORMAL."
- Owner toggle endpoint: `PATCH /api/devices/[deviceId]/screenshots` body
  `{enabled}` → writes `screenshotMonitoringEnabled` (route ~line 192).
- Summary pass: `app/api/internal/screenshot-sweep/route.ts` calls
  `runSummaryPass(summariseViaRelay)` from `lib/screenshot-summaries.ts` in its
  OWN try/catch AFTER the capture pass — a summary problem must never fail a
  capture. That containment rule carries over to S4.
- Triggers + digest (TASK_152 M5): `lib/screen-notifications.ts` (431 ln),
  CRUD at `/api/settings/screen-notifications`. Master switches on the USER row
  (`screenTriggerNotificationsEnabled`, `screenDigestEnabled`, default FALSE).
  Fan-out via `notifyUser`, honouring `notifyEmail / notifyTelegram /
  notifyAgent`. Event types `screen_trigger`, `screen_digest`. **Triggers/digest
  stay owner-scoped — admin CRUD for them is OUT OF SCOPE (§5).**

### Notification infra
- `lib/notify.ts` `notifyUser(userId, {eventType, subject, emailHtml,
  telegramText, ...})` — per-user prefs, NotificationLog on every send.
- `lib/telegram.ts` `notifyAdmin(text)` — telegram ONLY, fire-and-forget, gated
  on `telegramConfigured() && env.adminTelegramChatId` (ADMIN_TELEGRAM_CHAT_ID).
  `sendTelegramMessage(chatId, text)` + `sendTelegramMessageWithButtons` exist.
- `lib/email.ts` `sendEmail({to, subject, html, ...})`.
- `lib/env.ts`: `adminTelegramChatId` (~164), `adminEmail` =
  `ADMIN_EMAIL || EMAIL_FROM` (~168).
- `lib/notification-log.ts` `writeNotificationLog` — `userId: null` is the
  documented shape for admin-only notifications; additive-only, never throws.
- **Admin is NOT a User row**: `lib/admin-auth.ts` is a signed-token session
  (SESSION_SECRET), no role/isAdmin column on User. ⇒ admin prefs go in a NEW
  singleton table; admin NotificationLog rows keep `userId: null`. Existing
  `notifyAdmin` call sites (exe-license, find-or-create-user) are NOT migrated
  in this task.

### Presence
- NOTHING exists for web-user presence: no `lastSeenAt` on User, no
  beacon/`sendBeacon` anywhere in app/components. Device agent status/lastSeen/
  idleSeconds come from MeshCentral via `GET /api/devices`, formatted by
  `lib/device-idle.ts` (`formatIdle`, `IDLE_ACTIVE_MAX_SECONDS = 60`) — that is
  DEVICE presence, already correct, DO NOT TOUCH.
- The admin has no User row ⇒ presence tracks customer (dashboard) sessions only.

### Admin UI / API surfaces to extend
- Devices tab: `components/admin/devices-tab.tsx` (1319 ln). Per-row "Remote
  Control" button → `/admin=topsecret6199/device/101`. The Users tab "View
  devices" filter hand-off must keep working.
- Users tab: `UsersTab({ initialUsers })` at
  `app/admin=topsecret6199/(protected)/admin-panel.tsx:388`, fed by
  `GET /api/admin/users`. Per-user subroutes under
  `app/api/admin/users/[id]/` (devices, entitlements, invoices, tier,
  grant-premium, node-access) — the presence route joins that family.
- All admin device endpoints go through `assertAdminDeviceAccess` in
  `lib/admin-devices.ts` (deep 404, never 403; deleted ⇒ 404). Reuse verbatim.

## 2. Scope

### S1 — Actions dropdown on each ACTIVE device row (devices-tab.tsx)
Replace the per-row "Remote Control" button with an "Actions ▾" dropdown:
- `Open console` → same `/admin=topsecret6199/device/101` deep link as today.
- `Screen monitor…` → opens the S2 panel for that row.
Deleted-tab rows keep exactly their current Recover + run-command UI (no
dropdown). Keyboard accessible (button/menu roles, Esc + outside-click close),
no row-height change; if the table wrapper's `overflow` clips the menu, use a
fixed-position popover (check z-index against the panel header).

### S2 — Screen-monitor panel per device (popover, not a page)
Per-device panel showing/controlling:
- **Monitoring** toggle → `PATCH /api/admin/devices/[deviceId]/screen-monitor`
  `{enabled: boolean}` writing `Device.screenshotMonitoringEnabled` (same
  semantics as owner-land; an admin action never changes the owner's
  trigger/digest switches).
- **Cadence + retention** read-only (`screenshotCaptureIntervalMinutes`,
  `screenshotRetentionDays`).
- **Latest summary** read-only preview: newest frame's `summary` /
  `summaryError` / `summarisedAt` / capturedAt (missing summary renders the
  normal copy — never as an error).
- **Notify admin** toggle (S4) in the same panel.
- `GET /api/admin/devices/[deviceId]/screen-monitor` →
  `{enabled, captureIntervalMinutes, retentionDays, latestFrame: {capturedAt,
  summary, summaryError, summarisedAt} | null, adminNotifyEnabled}`.
Both routes: `assertAdminDeviceAccess` (deep 404), zod validation, audit rows
via the existing admin audit pattern with kinds `screen_monitor_toggle` and
`admin_notify_toggle`, so every flip is attributable.

### S3 — Admin notification channels + UI toggles
- New singleton table `AdminNotificationPref { id String @id
  @default("singleton"), notifyEmail Boolean @default(true), notifyTelegram
  Boolean @default(true), updatedAt DateTime @updatedAt }` (upsert on the fixed
  id — idempotent, no seed step).
- New `lib/admin-notify.ts`:
  `notifyAdminChannels(opts: {eventType, subject, telegramText, emailHtml})` —
  reads the pref row (upsert-if-missing), sends Telegram only when
  `notifyTelegram && telegramConfigured() && env.adminTelegramChatId`, email
  only when `notifyEmail && env.adminEmail`, writes one NotificationLog row per
  ATTEMPTED channel with `userId: null`, and contains every failure exactly like
  `notifyAdmin` (never throws — a notification must not break the action it
  reports on).
- `GET/PATCH /api/admin/notification-prefs` (admin-token gated like the rest of
  `/api/admin`) + a compact "Notifications [Telegram] [Email]" toggle pair in the
  admin shell header (`components/admin/admin-shell.tsx`). GET returns
  `configured: {telegram, email}` so the UI greys out a channel whose env var is
  unset instead of pretending the toggle will work.

### S4 — Per-device admin screen-monitor notifications
- New Device columns: `adminNotifyEnabled Boolean @default(false)` and
  `adminNotifyLastSentAt DateTime?` (cooldown latch).
- New pure helper + fan-out in `lib/screen-notifications.ts` (sibling of the
  trigger pass, same containment philosophy):
  `maybeAdminScreenNotify(device, frame)` — fires only when
  `adminNotifyEnabled && frame.summary` AND cooldown elapsed (trigger-constant
  pattern: default 120 min, min 5); payload = device name, owner email,
  capturedAt, summary text, deep link `/admin=topsecret6199/device/{id}`; then
  stamps `adminNotifyLastSentAt`. NotificationLog eventType `admin_screen_alert`.
- Called from the summary-pass path (screenshot-sweep) inside its OWN
  try/catch — an admin-notify problem must never fail a capture or the owner's
  summary pass. Writes nothing when the pref row has both channels off.

### S5 — Owner presence: schema, beacon, endpoints, UI
Schema (single migration together with S3/S4):
- `User.lastSeenAt DateTime?` — last heartbeat received (any state).
- `User.lastActiveAt DateTime?` — last heartbeat reporting real interaction.
- `User.lastSeenPage String?` — latest dashboard route (cap 200 chars).
- `UserPresenceEvent { id, userId → User, type String ("login"|"online"|"idle"|
  "offline"|"logout"), page String?, createdAt }` + `@@index([userId, createdAt])`.
  Written ONLY on state transitions (read last event; skip if same type) — zero
  per-ping rows. Retention: delete events older than 90 days in the EXISTING
  internal daily-sweep family (do not create a new cron route).
`lib/user-presence.ts` (unit-tested pure core, `lib/device-idle.ts` style):
- `HEARTBEAT_INTERVAL_MS = 60_000`; `OFFLINE_WINDOW_MS = 180_000` (2 missed
  pings); `IDLE_WINDOW_MS = 300_000`.
- `deriveUserPresence({lastSeenAt, lastActiveAt, now})` → "online" | "idle" |
  "offline": offline if `now - lastSeenAt > OFFLINE_WINDOW`; else idle if
  `now - lastActiveAt > IDLE_WINDOW`; else online. Nulls ⇒ offline.
- `recordUserHeartbeat({userId, page, interacting})` — updates the three User
  fields (bumps `lastActiveAt` only when `interacting`), emits transition events
  `login` (first heartbeat after an ≥ OFFLINE gap) / `online` / `idle` /
  `offline`.
Client: `components/presence-beacon.tsx` mounted in `app/dashboard/layout.tsx`
ONLY (customer app — the admin has no User row and must never appear in
presence data):
- 60 s `setInterval` POST `/api/presence` `{page, interacting}`; immediate ping
  on `visibilitychange→visible` and `pagehide` via `navigator.sendBeacon`;
- interaction listeners (pointerdown, keydown, touchstart, scroll) reset a
  5-minute idle timer driving the `interacting` flag.
Endpoint: `POST /api/presence` — session-authed (`getCurrentUser`), zod body,
returns `{ok: true}` only; must stay cheap (two column writes + rare event row).
Admin reads:
- `GET /api/admin/users` additionally returns `presence` (derived) +
  `lastSeenAt` per user.
- `GET /api/admin/users/[id]/presence` → last 100 `UserPresenceEvent`s (7-day
  window) for the activity drawer; deep 404 for unknown id.
- `GET /api/admin/devices` (lib/admin-devices list) additionally returns
  `ownerPresence` + `ownerLastSeenAt`, derived from the owner's User row at read
  time.
UI:
- UsersTab: Presence chip per row (online = green "active", idle = amber
  "idle Xm", offline = grey "offline · last seen …"); click → activity drawer
  listing the events. Chip also derived client-side from `lastSeenAt`/
  `lastActiveAt` with the SAME windows so a stale payload can't flicker the
  colour.
- devices-tab OWNER column: small presence chip under the owner email, visually
  distinct from the device STATUS column and labelled "owner presence" so it can
  never be read as the agent's status. "Real time" in v1 = the page's existing
  manual Refresh (30 s auto-refresh = named follow-up, NOT in scope).

## 3. Tests (playbook: every behaviour, both paths)

1. `tests/admin-screen-monitor.test.ts` — GET/PATCH screen-monitor: toggle
   writes `screenshotMonitoringEnabled`; cadence/retention/latest-frame shape;
   deep 404 for not-mine AND for deleted devices (never 403); zod rejects bad
   bodies; audit rows written for both toggle kinds; cooldown pure helper
   (fires / suppressed inside window / `summary: null` never fires).
2. `tests/admin-notify.test.ts` — pref toggles gate each channel independently;
   unset env ⇒ no send attempt on that channel; NotificationLog rows carry
   `userId: null` + right event/channel/outcome; a send failure does not reject
   the caller (containment).
3. `tests/user-presence.test.ts` — `deriveUserPresence` boundaries (just
   inside/outside both windows; nulls ⇒ offline); `recordUserHeartbeat`
   transition dedupe (steady-state pings add NO event rows; `login` after a
   gap; idle→online on interaction); retention cutoff helper.
4. `tests/admin-users-presence.test.ts` — `/api/admin/users` includes presence
   fields; `/api/admin/users/[id]/presence` returns the bounded list + deep
   404; admin devices list includes ownerPresence; `/api/presence` 401s with no
   session and upserts with one.
Existing gates must stay green: `npm run test:admin-devices`, `test:devices`,
`test:xdevice`, `test:wallet`, `test:module-gate`, `test:maintenance-cache`,
then full `npm run test`.

## 4. Rollout (playbook §VPS deploy + TASK_171/185 pattern)

1. ONE `prisma migrate deploy` on the VPS BEFORE service restart (2 new tables +
   5 new columns).
2. rsync app/lib/components/prisma/tests + package.json; remote `npm run build`;
   `systemctl restart spaceworker.service`; confirm `Compiled successfully` with
   ZERO admin-string leaks in the build log (TASK_188 gate — the secret route
   must not appear in build manifests).
3. Live verification via PROMPT_VERIFY_TASK_190.md; local-vs-remote parity file
   list; commit + push per slice (S1+S2, S3+S4, S5) — never one kitchen-sink
   commit.

## 5. Explicitly OUT of scope (say so in the writeup; don't half-build)

- Admin-panel CRUD for owner screen triggers/digest (owner-scoped by design).
- Changing owner-land UI or the owner's own notification prefs.
- Migrating legacy `notifyAdmin` call sites (exe-license, signup alerts) to
  `notifyAdminChannels`.
- Websocket/push real-time — presence and chips are poll-based in v1.
- Presence for admin sessions; per-device owner-presence history (user-level log
  only).
- Editing screenshot cadence/retention from the admin panel (read-only display).
- Auto-refresh of the devices/users tabs.

## 6. Risks / decisions already made

- Admin has no User row ⇒ prefs in singleton table; NotificationLog userId null.
- Presence beacon mounts ONLY in `app/dashboard/layout.tsx` — mounting it in the
  admin layout would pollute presence data with the operator's own session.
- Transition-only presence writes + 90-day retention = bounded growth.
- Admin screen-notify cooldown reuses the proven trigger-constant pattern
  (120 min default) — a notify-per-frame would be a spam cannon.
- Owner privacy unchanged: the admin monitoring toggle is a deliberate, audited
  action; nothing ever auto-enables monitoring.

## 7. Implementation checklist (edit as you go — playbook rule)

- [ ] S1 Actions dropdown (devices-tab.tsx) — tsc+eslint clean
- [ ] S2 screen-monitor GET/PATCH routes + panel UI + audits + test #1
- [ ] S3 AdminNotificationPref migration + lib/admin-notify.ts + prefs routes +
      header toggles + test #2
- [ ] S4 Device admin-notify columns + maybeAdminScreenNotify + sweep hook + test
      #1 cooldown cases
- [ ] S5 schema (User presence cols + UserPresenceEvent) + lib/user-presence.ts +
      /api/presence + beacon + admin reads + UsersTab chips/drawer +
      devices-tab owner chip + tests #3/#4
- [ ] Gates: tsc=0, eslint on touched files, test:admin-devices + new suites +
      full `npm run test`
- [ ] Deploy: migrate deploy → build → restart → PROMPT_VERIFY_TASK_190.md live
      pass → commit+push per slice

