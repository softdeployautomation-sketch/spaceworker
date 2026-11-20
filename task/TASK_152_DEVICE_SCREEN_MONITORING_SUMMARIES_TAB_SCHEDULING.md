# TASK_152 — Device screen monitoring: summaries, its own tab, scheduling, and input-off capture

**Status: SCOPED 2026-10-01. Not started. Supersedes and extends `TASK_127` Phase 2. Phase 3 (control) remains out of scope and its safety rules are carried forward verbatim in §7.**
**Scale:** this is the largest scoped task in the queue — 8 sub-tasks, several of which are new subsystems (a per-user capture scheduler, a summarisation pipeline, a trigger/notification engine). It is deliberately written as **phases that can stop cleanly**, not one release.

**Owner's words, verbatim:**
> *"in the screenshot of the automation, it connected with the input on the mesh console, because we don't have control over that, so for screenshot, the automation doesn't need to get into with input, the only time it needs to turn on input should be when there is a task, and we haven't gotten to that stage yet"*
> *"first I want that summary section"* … *"I want a way to summarise what's in each image somewhere, where the timeline and summaries are there, where users can scroll"*
> *"I want the screen monitoring to be in a separate tab not under summary, because we have a lot to build there, it's a real selling point, the final version should be able to take out task"*
> *"I want user to be able to set how frequent the screenshot is taken, doesn't have to be hardcoded every minute"*
> *"user should be able to select option for the agent to send summary through telegram after an important thing comes up like if the screen shows a balance or something user can add as a trigger for the notification, and users should be able to select how frequent the summary comes through notification, like if they want it every 2 hours, it should give summary of every monitored devices for that period"*
> *"since the pw browser takes big ram, we already have the admin choosing how many monitors can go I guess, but we need to be able to queue users task well accordingly as they want, so if others are not using the monitor, and the ram is still 60 below, we should be able to let such monitoring happen simultaneously. And any other one gets queued, and if the resource is just limited and the user wants monitoring on multiple devices, the agent should be able to time them, if the user is only giving 1 playwright browser for that moment, what should happen is switch between device every maybe 20 or 30 mins, so it can capture something from each, and should ease as admin gives more opportunity to that user from the governor, then it can automatically switch and continue the single task"*

---

## 1. What already exists (Phase 1 is BUILT — do not rebuild it)

This is **not** a greenfield feature. `TASK_127` Phase 1 shipped and is live.

| Piece | Where | Notes |
|---|---|---|
| Global dials | `AdminSetting.screenshotMonitoringEnabled` (default **false**), `screenshotCapturesMaxConcurrent` (**2**), `screenshotCaptureIntervalMinutes` (**60**), `screenshotRetentionDays` (**14**) | `prisma/schema.prisma:313-316` |
| Per-device consent | `Device.screenshotMonitoringEnabled` (default **false**), `screenshotIntervalMinutesOverride Int?`, `screenshotWakeDelayMinutes Int?`, `screenshotOnlineSinceAt` | `prisma/schema.prisma:1320-1346` |
| Frame record | `model DeviceScreenshot` | `prisma/schema.prisma:2008`; bytes live on **disk**, path stored **relative** to the screenshot root (`:2019`) |
| Capture engine | `lib/device-screenshots.ts` — `listDueDevices`, `captureViaService`, `resolveScreenshotSettings`, `countCapturing`, `listRecentFrames`, `deleteDeviceFrameTree` | |
| Browser service | `browser-capture/capture.ts` + `server.ts`, own process on `127.0.0.1:3403`, `deploy/screenshot-capture.service` | **Imports only node builtins + playwright** — `lib/` is NOT shipped to the VPS |
| APIs | `app/api/internal/screenshot-sweep/route.ts` (the sweep), `app/api/devices/[deviceId]/screenshots/route.ts` (GET/PATCH/DELETE), `.../screenshots/capture/route.ts` (manual), `.../screenshots/[frameId]/route.ts` (bytes), `app/api/admin/screenshots/route.ts` (4 dials) | |
| Governor membership | `deviceScreenshots` is a registered governed feature | `lib/resource-governor.ts:54`, `:514` |
| UI | `ScreenMonitoringCard` in `components/device-console.tsx:1841+`, mounted on **SummaryTab** at `:1700-1702`; console tabs typed at `:94` | |
| Tests | `tests/device-screenshots.test.ts` — 20 tests, real module + real governor | |

**Per-device frequency override already exists** (`screenshotIntervalMinutesOverride`, writable via `PATCH /api/devices/[deviceId]/screenshots` — the card at `device-console.tsx:1887+` already edits it). So M4 is largely **UI + policy relaxation**, not new machinery. Verify that before building anything.

---

## 2. The reported bug — capture turns on Input. CONFIRMED, and it is deliberate in the code today.

**This is the owner's first complaint and it is real.** `browser-capture/capture.ts:149-171`:

```
/**
 * Enable the Input (control) toggle the way the proven sequence did — WITHOUT
 * `force`, and never fatally.
 *
 * WHY PHASE 1 TOUCHES THIS AT ALL: the confirmed frame was taken with this
 * checkbox ticked, so this preserves the proven state rather than trusting that
 * a view-only session paints the same pixels. Phase 1 itself NEVER dispatches
 * input (no mouse or keyboard event is sent anywhere in this file) — ticking the
 * box grants a capability nothing here uses.
 */
async function enableInputToggle(frame: Frame): Promise<boolean> {
  ...
    await box.check({ timeout: 5_000 }); // no `force: true` — deliberately
```

**The code already agrees with the owner and does it anyway.** Its own comment states the box "grants a capability nothing here uses". The reason given is empirical: *the frame that was proven live was taken with the box ticked, and nobody verified that a view-only session paints the same pixels.*

That is a real, unresolved uncertainty — **and that is exactly why M1 must CONFIRM, not just delete the call.** Turning the checkbox off is a one-line change; the risk is that it silently produces black or blank frames, which would look like a capture failure and be misdiagnosed as a service problem. Measuring this is the task.

## 3. The other verified gaps

| # | Gap | Evidence |
|---|---|---|
| G1 | **No summary exists anywhere.** `DeviceScreenshot` has no summary column; the only text on a frame row is `failureReason`. | `prisma/schema.prisma:2008-2050` |
| G2 | **Monitoring is a card on the Summary tab, not a tab.** | `device-console.tsx:1700-1702` (mount), `:94` (tab union has no monitoring member) |
| G3 | **Frequency is admin-global with a per-device override already built**, yet the owner experiences it as "hardcoded every minute". Verify what the UI actually offers — this may be a discoverability gap, not a missing capability. | `device-console.tsx:1887+`, `screenshots/route.ts` PATCH |
| G4 | **No notification of any kind for monitoring events.** Nothing calls `notifyUser`/`notifyAdmin` from the capture or sweep path. | grep of `lib/device-screenshots.ts`, `screenshot-sweep` |
| G5 | **No per-user fairness in the capture scheduler.** Admission is pressure-only via the governor's `deviceScreenshots` slot. One user with many opted-in devices can consume the whole budget. | `lib/device-screenshots.ts` `listDueDevices`, `lib/resource-governor.ts` |
| G6 | **No rotation / time-multiplexing.** Nothing expresses "this user has 1 slot but 4 devices", so nothing switches between them. | no such cursor exists in the schema |

**Reuse, do not rebuild — these already solve adjacent problems:**
- `lib/notify.ts` `notifyUser(userId, …)` — already fans out to email / Telegram / agent thread **per the user's own preferences**. Use it; do not add a fourth channel.
- `lib/digest.ts:121-127` — an existing periodic digest delivered through `notifyUser`. **This is the precedent for the owner's "every 2 hours, summary of all monitored devices".**
- `lib/agent.ts` — the metered AI path (`AiUsageLog`, `aiDailyCapHundredthsCent`). **Any vision call MUST go through this**, never a side channel (`TASK_127:50`).
- The governor's priority classes (`premium`/`standard`/`trial` + starvation promotion at `governorStarvationPromoteMin`) — reuse for fairness rather than inventing a second priority system.
- `NotificationLog` — the existing delivery audit trail.


---

## 4. Work order

Phases are ordered so each can stop cleanly. **M1 and M2 are independent of everything else and are the highest value per hour.** **M5 must not start before M3 exists** — there is nothing to summarise or trigger on until summaries exist.

### M1 — Capture must NOT enable Input  ← **the reported bug**
**CONFIRM FIRST.** The fix is trivial; the verification *is* the work.
1. Reproduce today's behaviour and record what the mesh console shows (the owner observed the Input toggle engaged).
2. **Measure whether a view-only session paints the same pixels.** Capture the same device/screen twice — once with the Input box ticked, once without — and deliver a **byte/structural comparison plus both images** and a stated verdict.
   - Equivalent → remove the tick from the screenshot path entirely.
   - Different (black/blank/degraded) → **do not ship the removal.** Report with evidence and stop for a decision. A blank frame is worse than an unused capability.
3. Restructure so the capability is **explicit and parameterised**, not implied:
   - `captureScreen` takes an explicit named option (e.g. `enableInput`) that **defaults to `false`**.
   - The sweep/screenshot path **always passes `false`**.
   - A comment states the rule: *Input is enabled only when a task must drive the device; observation never needs it.*
   - Make the `true` branch **unreachable or explicitly guarded** — the task/control phase does not exist (§M8), so this must not silently regress when Phase 3 is scoped.
4. Do not touch the disconnect mechanism (`cmdeskaction(11, null)`) or the two-step Connect — both are load-bearing findings at `capture.ts:1-40`.
5. `browser-capture/` imports **only node builtins + playwright**. A `lib/` import crashes on the VPS.

**Evidence:** both images, the comparison, the before/after code, and which verdict you reached and why.

### M2 — Screen monitoring becomes its own console tab
1. Add `"monitoring"` to the tab union (`device-console.tsx:94`) and the tab strip (`:346`), following the existing pattern.
2. Move `ScreenMonitoringCard` off Summary (`:1700-1702`) onto the new tab. **Keep it mounted exactly once** — read the comment at `:466-479` about the MeshCentral viewer token being replayed on a Summary round-trip; the same class of bug bites if this card is mounted twice or remounted on tab switches.
3. Summary keeps a **one-line pointer** to the new tab, not the full card.
4. `app/console/[deviceId]/page.tsx` and the admin mirror must still deep-link. Check whether an initial-tab query param is honoured and extend it if the console is linked with a tab.

**Evidence:** rendered screenshots of both tabs; a raw DOM check that only **one** card instance is mounted; proof the device's own opt-in switch still works from the new location.

### M3 — Per-frame summaries + scrollable timeline  ← **the "summary section"**
**Prerequisite for M5.**
1. Additive schema: a **nullable** summary per frame. Do not overwrite `failureReason`. A frame with no summary is normal (not yet summarised, or over budget) — the UI must not render that as an error.
2. Summarise through `lib/agent.ts`'s **metered** path, respecting the per-user daily AI cap. On exhaustion leave frames unsummarised and record why. **Never fail a capture because summarisation failed** — the two must fail independently.
3. **Cost gate — decide and justify.** `TASK_127:58` recommended one vision call **per device per day**, explicitly *not* per frame, because per-frame vision multiplies cost per device per day. The owner now wants per-image summaries. Reconcile: batch several frames into one call where the model allows, prefer a cheaper model for routine frames, and **state the resulting cost per device per day**. Do not silently pick the expensive option.
4. Timeline UI on the monitoring tab (M2): frames reverse-chronological with each summary beside it, **scrollable**, preserving the existing thumbnail/open-in-place behaviour. The goal is *"quickly recollect"* — it must scan, not require clicking each frame.
5. Retention interacts with this: `screenshotRetentionDays` deletes raw frames. Decide and **state** what happens to a summary when its frame is deleted (keeping the text after the image expires is defensible — but it must be deliberate and documented).

**Evidence:** raw rows showing summaries persisted against real frames; the rendered timeline; a frame with no summary rendering sanely; the AI-cost figure per device per day; and the cap-exhaustion path.

### M4 — User-configurable capture frequency
**Verify the existing override first — this may be mostly UI.** `Device.screenshotIntervalMinutesOverride` and its PATCH already exist.
1. Make cadence user-visible and settable from the monitoring tab, within bounds the admin still controls. Decide and state whether the admin's global value is a default or a ceiling, and **enforce it server-side**, not in the UI only.
2. Preserve `screenshotWakeDelayMinutes` — it exists for a reason and must keep working.
3. Additive: a device with no override keeps today's behaviour exactly.
4. Validate at the edge the way the admin route already does (`app/api/admin/screenshots/route.ts` `WRITABLE` rejects rather than clamps).

**Evidence:** raw PATCH round-trips for set/clear; a due-list assertion showing the override changes **when a capture is actually due** (not merely what is stored); proof the default path is unchanged.


### M5 — Triggers + Telegram notification + periodic digest   (**do not start before M3**)
1. **User-defined triggers.** Let a user define what counts as important — the owner's example is *"the screen shows a balance or something"*. First version is scoped to **text/keyword triggers matched against the frame summary** (a balance appearing, an error, a specific word), defined per user and optionally per device. **Do not attempt general visual/complex-event triggers in this version** — say so explicitly in the report.
2. **Deliver via `notifyUser`**, honouring per-channel preferences (`notifyEmail`/`notifyTelegram`/`notifyAgent`). A user with Telegram off must not get a Telegram message. Reuse `lib/notify.ts`.
3. **A firing trigger must be rate-limited.** A "balance" that stays on screen for 6 hours would otherwise fire every capture. Define, implement, and state a cooldown.
4. **Configurable summary cadence** — the owner wants *"every 2 hours … summary of every monitored device for that period"*. Model on `lib/digest.ts`, aggregating **all of that user's monitored devices** for the window into one message.
5. Both settings need clear UI, sane defaults, and an obvious off switch. A notification feature that defaults to on is how trust is lost.
6. Record every delivery through the existing `NotificationLog` — do not invent a parallel log.

**Evidence:** a trigger firing on a real summary and delivered per-channel; the cooldown proven by showing an immediate second capture does **not** re-fire; a periodic digest covering ≥2 devices in one message; a Telegram-disabled user receiving **no** Telegram (raw `NotificationLog` rows).

### M6 — The capture scheduler: concurrency, fairness, rotation  ← **the hardest item**
**What the owner means by "handle a lot of scenarios".** Today admission is pressure-only via the governor: no per-user queue, no fairness, no rotation.
1. **Headroom-based concurrency.** The owner's intent: if the box is idle and other users are not monitoring, allow monitoring **simultaneously**; otherwise queue. Note the governor already has `governorRamWarnPct` (75) / `governorRamHardPct` (90). **Reconcile the owner's ~60% with those dials rather than hardcoding a third number.** State which threshold you used and why; make it a dial, not a literal.
2. **Per-user fairness.** One user opting in several devices must not consume the whole budget and starve others. Define the rule explicitly (per-user cap, round-robin across users, or weighted by priority class). **Prefer reusing the governor's existing `premium`/`standard`/`trial` classes and starvation promotion** over inventing a second priority system.
3. **Rotation / time-multiplexing.** When a user's *eligible device count* exceeds their *granted slots*, capture must not stop and must not favour one device forever. Rotate so every device is sampled (owner's figure: **every 20-30 min**). Implement as a **persisted rotating cursor per user** (survives restart), with the slice length a bounded, configurable value — not a literal.
4. **Automatic upgrade when capacity grows.** When the admin raises the cap or pressure drops, the scheduler must **stop rotating and go parallel** for that user **without a restart**. Derive it from current state on every pass; never cache it.
5. **Automatic degrade when capacity shrinks** (the inverse): a running parallel set falls back to rotation **without losing queued work**.
6. **Anything that cannot run stays queued and eventually runs.** No dropped frames; no failed rows from contention alone. Distinguish *"device offline"* (a real failure — existing behaviour) from *"has not had its turn yet"* (**not** a failure).
7. Keep `countCapturing` / the `deviceScreenshots` governor slot as the **single admission authority**. Do **not** add a parallel counter — `prisma/schema.prisma:298-303` explicitly forbids it.

**Evidence — raw state, not prose:**
- **1 slot / 4 devices**: paste the rotation across successive scheduler passes, proving every device got a turn and none starved.
- Same scenario with the cap **raised mid-run**: prove it switches to parallel **without a restart** and rotation stops.
- Inverse: cap **lowered mid-run** → prove it degrades back to rotation and **loses no queued work**.
- **Two users** (one with many devices, one with one): prove the second user still gets captures, with counts — the fairness claim.
- Paste the persisted cursor rows **across a process restart**.

### M7 — Summaries feed the agent's context
Owner's end goal: *"talking to the agent who got all context of the user's summaries."*
1. Make a user's monitor summaries retrievable by that user's agent thread, following **however the existing agent context is assembled** (read it first; do not invent a new mechanism).
2. **Respect the same metering** — retrieval must not bypass `lib/agent.ts`'s cap.
3. **This is read-only.** It grants the agent no new authority over a device. Phase 3 (§7) is not part of this task.

### M8 — Explicitly deferred: task-driven input  (**do not build in this task**)
The owner said *"the final version should be able to take out task"* and *"the only time it needs to turn on input should be when there is a task."*

**There is no task system today.** `lib/automation-run.ts` models *email campaigns*, not device tasks — **do not repurpose it.** Creating device tasks (and the input they need) is a separate, higher-risk capability. M1 makes input **explicit and off by default**; M8 is where it would be used. **Do not build M8 here.** Before it is scoped, the Phase 3 safety rules in §7 apply unchanged and the owner must re-confirm them at that time.


---

## 5. Release phasing — each phase stops cleanly

Do **not** attempt this as one release. Each phase ships, is verified, and stops.

| Phase | Items | Why it stops cleanly | Dependency |
|---|---|---|---|
| **A** | M1 + M2 | Fixes the reported input bug and moves the card. No schema, no AI, no scheduler. | none |
| **B** | M3 + M4 | The "summary section": summaries + timeline + user cadence. Needs one additive column. | after A (timeline lives on the new tab) |
| **C** | M5 | Triggers + Telegram + periodic digest. | **after B** — nothing to trigger on without summaries |
| **D** | M6 | Scheduler: concurrency + fairness + rotation. Highest risk, most scenarios. | after B; independent of C |
| **E** | M7 | Summaries into agent context. | after B |

**Recommended order: A → B → C → D → E**, but C and D may be swapped. **D should not be rushed** — it is the item most likely to be under-built and the one that dictates whether this feature behaves well at scale.

## 6. Non-negotiable rules

- **Live app only.** Repo `/Users/mikeolab/spaceworker`, branch `main`. Nothing here goes to `/Users/mikeolab/sw-selfhost` (a separate product line, with its own in-flight work).
- **Do not rebuild Phase 1.** Capture works today; this task extends it.
- **`browser-capture/` imports only node builtins + playwright.** `lib/` is not shipped to the VPS and several `lib/` modules `import "server-only"`, whose default entry **throws** in a plain Node process. Adding a `lib/` import here breaks production (`capture.ts:1-40`).
- **Any AI call goes through `lib/agent.ts`'s metered path.** No side channel, no bypassing `aiDailyCapHundredthsCent`.
- **One admission authority.** The governor's `deviceScreenshots` slot / `countCapturing` is the only gate. Do not add a parallel counter (`schema.prisma:298-303`).
- **Per-channel notification prefs are the user's.** Never send on a channel the user disabled.
- **Additive and nullable-safe schema changes.** Ship them as migrations. Do not `prisma migrate`/`db push` against a shared or live DB — build a **scratch** DB and drop it.
- **NEVER edit `.env`.** It is a symlink into the live app.
- **NEVER edit anything under `src-tauri/target/`** — gitignored build output holding **stale copies** of app source. Only `app/`, `lib/`, `components/`, `prisma/`, `tests/`, `browser-capture/` are real.
- **Consent stays per-device and defaults to off.** `screenshotMonitoringEnabled` on both `AdminSetting` and `Device` is `false` by default — do not change a default.
- **Raw frames are screenshots of someone's device.** Treat them as sensitive: keep the existing retention behaviour, and do not widen who can read a frame or a summary.
- **Stage by explicit path.** Never `git add -A` / `git add .`. Report the commit SHA.

## 7. Phase 3 safety rules — carried forward VERBATIM from `TASK_127`, must not be lost

Phase 3 (agent **control** of the device) remains **out of scope** for TASK_152. These rules were decided so they could not get lost later. They apply unchanged whenever Phase 3 is scoped:

> - **Every control action (mouse/keyboard/form input on the real device) is an `AgentPendingAction`, no exceptions.** The existing approval gate (CROSS-TRACK RULE 1) is the ONLY path to a real device mutation anywhere in this codebase — control-phase actions do not get a bypass just because they originate from an automated monitoring loop instead of a chat message.
> - **A purchase (anything spending real money) needs its own, more deliberate confirmation** than a generic pending-action tap — at minimum, the proposal must show exactly what will be bought, for how much, and on which site/account, before a human taps approve. Silent/implicit approval (e.g. "auto-approve if under $X") is explicitly OUT OF SCOPE unless the user asks for that tradeoff explicitly and separately, in writing, at build time.
> - **Confirmed 2026-09-27 (owner)**: the flow is propose → human says proceed → AND every individual checkout step is independently gated too, not just the initial "go do this" approval. Two-stage gating, not one: (1) approve the overall task/intent, (2) approve the actual checkout/payment submission as its own, separate tap, showing the real amount/destination at that moment (not just what was proposed earlier, in case the actual checkout total differs).
> - **Research question, not yet answered**: "we already have apps doing that, we can fork one" — identify which existing open-source computer-use/browser-use agent (e.g. browser-use, Skyvern, self-operating-computer, or similar) is the best fit to fork vs. build fresh, but do this as its own research pass at pickup time, not assumed now.
> - Consider whether Phase 3 needs a distinct per-device, per-capability opt-in (separate from Phase 1's monitoring opt-in) — controlling a device is a materially different consent boundary than screenshotting it.

**Note the direct link to M1:** because M8 (task-driven input) is deferred, M1's job is to make the input capability **explicit and unreachable by default**. That is what keeps the Phase 3 safety boundary intact instead of leaving a live capability nothing uses.

## 8. Still-open questions from `TASK_127` (resolve as you hit them, do not assume)

- Playwright as a real dependency + `npx playwright install --with-deps chromium` (~300MB) as part of VPS setup vs. a one-time manual install step (same category as the worker's Python venv).
- The visible "someone is viewing your screen" / active-session indicator was **never verified** from outside the VM. Verify before treating captures as invisible.
- Where raw frames live (disk vs object storage vs `bytea`) — disk today; `TASK_31`'s Flux images are the closest precedent if storage is revisited.
- Exact vision model / cost per summary call, weighed against the existing per-user daily AI cap — **this is M3 item 3.**

