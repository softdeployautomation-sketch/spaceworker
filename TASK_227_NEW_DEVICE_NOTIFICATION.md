# TASK_227 — Notify the user when a NEW device is first enrolled

**Scoped by:** verification agent · **Date:** 2026-10-18 · **Priority:** medium-high (owner request; the only device event with no notification)
**Branch when built:** `agent/task-227-new-device-notification` off `origin/main` (`c9aa516` or newer)
**Handoff:** `TASK_227_NEW_DEVICE_NOTIFICATION_STEPS.md`

## §1 The ask (owner's words)

> "we have a missing notification for when a new device is added.. other notification works like online and offline. but the time the device first got in is not notified."

## §2 Findings (why the gap exists — verified)

- Online/offline works via `app/api/internal/device-status-sweep/route.ts` (systemd timer, 5-min) → `lib/notify.ts` `notifyUser()`, transition-only against `Device.lastNotifiedOnline`.
- **The first-sweep skip is deliberate** — sweep comment: `lastNotifiedOnline === null` means "never swept" and skips notifying, so a brand-new device would **never** get any first-appearance alert through that path. Nobody ever filled that gap.
- **The true "device first got in" moment already exists:** `recordHeartbeat()` in `lib/devices.ts:123` — the create branch (L146) returns `created: !existing` (L166). Exactly one row per `vantraAgentId`; first heartbeat = enrollment.
- `ensureHostedDestination()` (`lib/clone-destination.ts:50`) also creates a Device row — the **pseudo-device** "SpaceWorker hosted" (no `vantraAgentId`, never heartbeats). It must NOT notify.

## §3 Scope (build this)

1. **Hook in `recordHeartbeat`** (`lib/devices.ts`, create branch only): when `created === true`, fire `notifyUser(userId, { eventType: "device_added", subject: "New device added: <name>", emailHtml: "<p><strong><name></strong> is now registered to your account (<osName> <osVersion>).</p>", telegramText/agentText: "🆕 New device added: <name>." })` — mirror the sweep's call shape exactly. **Must never break the heartbeat:** wrap in try/catch, log failure, return the normal `{ deviceId, created }` regardless.
2. **New pref column `User.notifyDeviceAdded Boolean @default(true)`** — additive migration (`ALTER TABLE "User" ADD COLUMN "notifyDeviceAdded" BOOLEAN NOT NULL DEFAULT true`), house style (online/offline are already separate booleans). The existing `telemetry_disabled` throw in `recordHeartbeat` keeps the master toggle in control — no new gating logic there.
3. **Prefs UI:** new checkbox "New device added" in `components/notifications-settings.tsx` next to online/offline (exact pattern at L176-178: `checked` + `patch({ notifyDeviceAdded: v }, "…saved")`), and update the prefs GET/patch endpoint's `select`/payload to carry the new field (find via the component's fetch).
4. **Sweep interaction (regression pin):** the sweep's `lastNotifiedOnline === null` first-sweep skip stays as-is — no double message ("new device" at heartbeat, no spurious "back online" later).

## §4 MUST NOT touch

- The sweep route's transition logic / null-skip semantics (commented as deliberate, 2026-09-26).
- `ensureHostedDestination` / clone-destination (pseudo-device must stay silent — pinned by test).
- Heartbeat response contract (`{ deviceId, created }`), `DeviceHeartbeat` rows, telegram push (SpaceWorker is email-only per `NotificationLog` comment; `notifyUser` fills generic fields).
- No destructive migration; no `.env`; no deploy (senior verification agent + owner 🚦).

## §5 Owner decisions (flag, don't build)

1. Migration + redeploy required this time (first of the three 226/227 tasks with a schema change) — additive-only, default-on; senior agent runs the §6b drift check after deploy.
2. Copy tone: "is now registered to your account" vs "has enrolled" — trivial, default kept.

## §6 Gates & tests

- `npx tsc --noEmit` exit 0 · eslint touched files · full `npm test` (floor: 1677 tests / 1676 pass / 0 fail / 1 skip) · `CI=true npm run build` · `prisma validate`.
- New tests: (1) first heartbeat → exactly one `device_added` notification, second heartbeat → none; (2) `notifyDeviceAdded=false` → device still created, no notification; (3) `notifyUser` throwing → heartbeat still succeeds; (4) `ensureHostedDestination` → no notification (pin); (5) prefs roundtrip carries the new field; (6) master `deviceTelemetryEnabled=false` → existing `telemetry_disabled` throw, no notification (existing behavior pinned).
- STEPS doc with evidence + `HANDOFF → VERIFICATION AGENT` section; migration diff pasted (must be add-column-only).
