# Task 127 — Hourly device screenshots + daily AI activity summary (future, not started)

**Status: idea captured 2026-09-26, NOT started. No deploy, no schema, no code yet.**
**Context: user wants to test agent-driven device monitoring via Telegram; this was the example use case, explicitly "just an example... find a way we can create something like that."**

## Read first (mandatory, once picked up)
- `lib/vantra-link.ts`, `lib/device-tools.ts` — how SpaceWorker already talks to Vantra's device layer (the `VANTRA_INTERNAL_TOKEN` cross-app auth pattern, mesh URL rewriting for `mesh.spaceworker.top`).
- `/Users/mikeolab/vantra/lib/meshcentral-api.ts` — the ONLY existing MeshCentral integration (node listing, view-only share links). **No screenshot function exists anywhere in either repo today.**
- `lib/agent.ts`'s Task 40 daily AI cap (`aiDailyCapHundredthsCent` / `AiUsageLog`) — any AI vision call this task adds MUST go through the same metered path, not a side channel.
- `TASK_94_TELEGRAM_APPROVAL_LOOP.md` + this session's two-way Telegram chat work (`telegramChatEnabled`) — the delivery channel this feature would likely use for the daily summary.

## Feasibility findings (researched 2026-09-26, before committing to build)
- MeshCentral has no simple "give me the last frame" REST endpoint. Getting a screenshot requires briefly opening a real desktop-control connection to the agent (the same mechanism `createViewOnlyShareLink`/live remote control already uses), capturing one frame, then closing it.
- The device's OS-side MeshCentral agent may show a visible "someone is viewing your screen" indicator for each capture, even a one-second one — needs verifying per-OS (Windows/macOS agent behavior may differ) before treating this as invisible/background.
- Requires the target device's agent to be online at the scheduled capture time; a device that's asleep/offline just misses that hour's frame (should degrade gracefully, not error the whole sweep).
- AI cost: analyzing every hourly frame with a vision model would multiply cost per device per day. Recommendation carried into the plan below: batch it — one vision call per device per day over the day's collected frames, not 24 separate calls.

## Goal
Let a user opt a specific device into hourly screenshot capture, then get one AI-written summary of "what happened on this device today" delivered via Telegram (reusing `telegramChatEnabled`) and/or the dashboard.

## Proposed shape (not finalized — re-validate against the codebase at pickup time, things may have moved)
1. **Per-device opt-in setting** (new `Device` field, e.g. `screenshotMonitoringEnabled`, default false — never on by default for anyone's device without explicit consent).
2. **Hourly sweep** (systemd timer, same pattern as `automations-sweep`/`payment-verify`): for each opted-in device with a live Vantra agent link, open a short MeshCentral desktop-control session, capture one frame, store it (object storage or a `DeviceScreenshot` table pointing at a file path — decide at pickup time; don't inline base64 into Postgres rows), close the session immediately. Missing/offline device = skip, not error.
3. **End-of-day job**: for each device with today's frames, ONE vision-model call summarizing the set (not one call per frame) → a short human-readable summary.
4. **Delivery**: send the summary via the existing `notifyUser` fan-out (respects `notifyEmail`/`notifyTelegram`/`notifyAgent` per user) — reuse infra, don't build a fourth channel.
5. **Retention**: decide a real deletion policy for the raw frames (e.g. delete after N days) — these are literal screenshots of someone's device, treat them as sensitive by default.

## Non-goals (for a first version)
- Real-time/live monitoring (this is periodic + retrospective, not a dashboard feed).
- Cross-device comparison or trend analysis — just "what happened on this device today."
- Any capture without the device owner's explicit per-device opt-in.

## Open questions to resolve before starting
- Does the MeshCentral agent's screen-capture indicator make hourly captures too disruptive to be viable as "background monitoring"? (Blocking question — verify live on a real test device first, before writing the sweep.)
- Where do raw frames live (object storage vs. local disk vs. Postgres bytea) — this repo has no existing image-blob storage pattern to copy from; TASK_31's themed-template Flux images might be the closest precedent to check.
- Exact vision model / cost per summary call, weighed against the existing per-user daily AI cap.

## Acceptance (once built)
- A real opted-in test device produces real hourly frames across a real day (or a compressed test window), one real AI summary is generated and delivered via Telegram, disabling the per-device toggle stops captures with zero errors, and an offline device during a scheduled capture never breaks the sweep for other devices.
