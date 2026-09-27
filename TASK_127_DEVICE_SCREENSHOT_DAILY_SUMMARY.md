# Task 127 — Device screenshot monitoring → AI summary → (later) agent control

**Status: idea captured 2026-09-26, refined 2026-09-27. Phase 1 + Phase 2 are READY TO ASSIGN TO CLINE once the click-automation investigation below (Claude, live VM test) confirms the exact click sequence — do not start Phase 1 build before that lands. No deploy, no schema, no code yet.**
**Context: user wants to test agent-driven device monitoring via Telegram; this was the example use case. Refined 2026-09-27: rather than a new MeshCentral API integration, drive the EXISTING console UI's own manual Connect button via browser automation. Also, explicitly, a later phase: not just observing the device but eventually CONTROLLING it — "help make purchases and so on" — see the safety section below before ever touching that phase.**

## Live investigation in progress (2026-09-27, Claude)
The owner confirmed today that the console's Connect button does NOT fully automate the MeshCentral session:
after our own Connect click, MeshCentral's OWN in-iframe UI still requires a SEPARATE manual click to actually
take "Control" (view rights vs. control rights are apparently not the same as loading `mesh.control` — this
needs live confirmation, since `lib/trmm.ts`'s `MeshCentralUrls.control` is nominally already the control-mode
URL, not the view-only one). Similarly, our own Disconnect only navigates the user away — it does NOT click
MeshCentral's own in-iframe Disconnect, potentially leaving a mesh-side session dangling. Both of these must be
understood and, if at all possible, automated (find the actual DOM element/selector for MeshCentral's in-iframe
Control and Disconnect controls, and confirm whether `mesh.spaceworker.top` is same-enough-origin for
script-driven clicks into the iframe, or whether this requires a different approach, e.g. a MeshCentral URL
parameter that skips the manual Control click entirely) BEFORE Phase 1's build starts — this is the actual
mechanism Phase 1 depends on. If it turns out NOT automatable, the whole "drive our own UI" approach in Phase 1
needs to be reconsidered.

## Read first (mandatory, once picked up)
- `lib/vantra-link.ts`, `lib/device-tools.ts` — how SpaceWorker already talks to Vantra's device layer (the `VANTRA_INTERNAL_TOKEN` cross-app auth pattern, mesh URL rewriting for `mesh.spaceworker.top`).
- `components/device-console.tsx` (~line 2454-2464, ~2861) — the **existing manual Connect button**: "The console's own Connect is a NORMAL action... Connect button is the only way to start one here." This is the button Phase 1 below automates a click on — reuse this exact flow rather than a new MeshCentral API integration.
- `/Users/mikeolab/vantra/lib/meshcentral-api.ts` — the only existing direct MeshCentral integration (node listing, view-only share links). Still no direct screenshot API — which is exactly why Phase 1 goes through the UI instead.
- `lib/agent.ts`'s Task 40 daily AI cap (`aiDailyCapHundredthsCent` / `AiUsageLog`) — any AI vision call this task adds MUST go through the same metered path, not a side channel.
- `lib/agent-executor.ts` / `AgentPendingAction` (the single approval gate, CROSS-TRACK RULE 1) — **mandatory reading before Phase 3**, not optional.
- `TASK_94_TELEGRAM_APPROVAL_LOOP.md` + this session's two-way Telegram chat work (`telegramChatEnabled`) — the delivery/interaction channel this feature would likely use.

## Feasibility findings (researched 2026-09-26)
- MeshCentral has no simple "give me the last frame" REST endpoint — confirmed no screenshot function exists anywhere in either repo today.
- The device's OS-side MeshCentral agent may show a visible "someone is viewing your screen" indicator for each capture — needs verifying per-OS before treating any capture as invisible/background, REGARDLESS of which mechanism (direct API or browser automation) ends up taking the frame.
- Requires the target device's agent to be online at capture time; an asleep/offline device just misses that capture (must degrade gracefully, never error the whole sweep).
- AI cost: analyzing every hourly frame with a vision model would multiply cost per device per day. Recommendation: batch it — one vision call per device per day over the day's collected frames, not one call per frame.

## Phase 1 — automated capture (refined approach, 2026-09-27)
Instead of a new MeshCentral API integration, drive SpaceWorker's OWN console page like a real (headless) user would:
1. A headless browser (Playwright is the natural fit — check what's already in `package.json` before adding a new dependency) logs in with a real session, opens `/console/[deviceId]`, clicks the existing **Connect** button (`components/device-console.tsx`), waits for the MeshCentral iframe's remote-desktop view to actually render.
2. Screenshot the rendered frame (the browser page itself, or specifically the iframe's canvas), save it, then close the session the same way a manual user would (don't leave sessions dangling — check what "disconnect" does in `device-console.tsx` today and mirror it).
3. Runs on a systemd timer (same pattern as `automations-sweep`/`digest-sweep`), per opted-in device.
4. Store frames as files (object storage or local disk path referenced by a new `DeviceScreenshot` row) — never inline base64 into Postgres.

This reuses 100% of the existing, already-working Connect flow and auth — no new MeshCentral-side integration, no new trust boundary. The tradeoff: it's a real (if headless) browser session per capture, so it inherits whatever visible "someone is connected" indicator the manual flow already has.

## Phase 2 — extraction + summary
1. **End-of-day job**: for each device with today's frames, ONE vision-model call summarizing the set (not one call per frame) → a short human-readable summary.
2. **Delivery**: send the summary via the existing `notifyUser` fan-out (respects `notifyEmail`/`notifyTelegram`/`notifyAgent` per user) — reuse infra, don't build a fourth channel.
3. **Retention**: decide a real deletion policy for the raw frames (e.g. delete after N days) — these are literal screenshots of someone's device, treat them as sensitive by default.

## Phase 3 — agent CONTROL of the device (explicitly separate, explicitly higher-risk)
The user's stated end goal goes beyond watching: "the next step will be to control, maybe help make purchases and so on... we already have apps doing that, we can fork one or build it." This is a distinct capability class from Phases 1-2 (passive observation) and must be scoped and safety-reviewed on its own — **do not fold it into the same build as Phase 1/2 without re-confirming with the user at that time.**

Non-negotiable safety requirements, decided now so they can't get lost later:
- **Every control action (mouse/keyboard/form input on the real device) is an `AgentPendingAction`, no exceptions.** The existing approval gate (CROSS-TRACK RULE 1) is the ONLY path to a real device mutation anywhere in this codebase — control-phase actions do not get a bypass just because they originate from an automated monitoring loop instead of a chat message.
- **A purchase (anything spending real money) needs its own, more deliberate confirmation** than a generic pending-action tap — at minimum, the proposal must show exactly what will be bought, for how much, and on which site/account, before a human taps approve. Silent/implicit approval (e.g. "auto-approve if under $X") is explicitly OUT OF SCOPE unless the user asks for that tradeoff explicitly and separately, in writing, at build time.
- **Confirmed 2026-09-27 (owner)**: the flow is propose → human says proceed → AND every individual checkout step is independently gated too, not just the initial "go do this" approval. Two-stage gating, not one: (1) approve the overall task/intent, (2) approve the actual checkout/payment submission as its own, separate tap, showing the real amount/destination at that moment (not just what was proposed earlier, in case the actual checkout total differs).
- **Research question, not yet answered**: "we already have apps doing that, we can fork one" — identify which existing open-source computer-use/browser-use agent (e.g. browser-use, Skyvern, self-operating-computer, or similar) is the best fit to fork vs. build fresh, but do this as its own research pass at pickup time, not assumed now.
- Consider whether Phase 3 needs a distinct per-device, per-capability opt-in (separate from Phase 1's monitoring opt-in) — controlling a device is a materially different consent boundary than screenshotting it.

## Non-goals (for Phase 1/2's first version)
- Real-time/live monitoring (this is periodic + retrospective, not a dashboard feed).
- Cross-device comparison or trend analysis — just "what happened on this device today."
- Any capture without the device owner's explicit per-device opt-in.
- Anything from Phase 3 — do not build control capability as part of shipping Phase 1/2.

## Open questions to resolve before starting Phase 1
- Is Playwright (or similar) already a dependency anywhere in this repo, or would it be new? Check before assuming.
- Does the visible "someone is viewing your screen" indicator (if the MeshCentral agent shows one) make even headless, brief captures too disruptive to be viable as "background monitoring"? Verify live on a real test device first.
- Where do raw frames live (object storage vs. local disk vs. Postgres bytea) — no existing image-blob storage pattern in this repo to copy from; TASK_31's themed-template Flux images might be the closest precedent to check.
- Exact vision model / cost per summary call, weighed against the existing per-user daily AI cap.

## Acceptance (Phase 1/2, once built)
- A real opted-in test device produces real captured frames across a real day (or a compressed test window) via the automated Connect-and-screenshot flow, one real AI summary is generated and delivered via Telegram, disabling the per-device toggle stops captures with zero errors, and an offline device during a scheduled capture never breaks the sweep for other devices.
- Phase 3 has NO acceptance criteria yet — it doesn't get scoped until Phase 1/2 ship and the user explicitly asks to proceed.
