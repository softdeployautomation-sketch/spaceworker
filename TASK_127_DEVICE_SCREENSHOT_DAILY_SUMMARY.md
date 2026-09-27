# Task 127 — Device screenshot monitoring → AI summary → (later) agent control

**Status: idea captured 2026-09-26, refined 2026-09-27, click-automation CONFIRMED WORKING LIVE 2026-09-27 (Claude, real test device "Sc"). Phase 1 + Phase 2 are READY TO ASSIGN TO CLINE — the exact automation sequence below is proven, not theoretical. No deploy, no schema, no code yet; this doc is the full spec to build from.**
**Context: user wants to test agent-driven device monitoring via Telegram; this was the example use case. Refined 2026-09-27: rather than a new MeshCentral API integration, drive the EXISTING console UI's own manual Connect button via browser automation. Also, explicitly, a later phase: not just observing the device but eventually CONTROLLING it — "help make purchases and so on" — see the safety section below before ever touching that phase.**

## Live investigation — CONFIRMED WORKING (2026-09-27, Claude, Playwright against real device "Sc")
Used Playwright (installed on the VPS — Ubuntu 22.04, `npx playwright install --with-deps chromium` worked
cleanly; NOT yet a real project dependency, see open questions) with a real minted session cookie for the
device's actual owner, against `https://spaceworker.top/console/<deviceId>`. Full sequence, proven end to end:

1. **Our own Connect** — `page.getByRole("button", { name: /^connect$/i })` on the SpaceWorker console page.
   This loads the `mesh.spaceworker.top` iframe (`mesh.control` URL) but does NOT start a live session by
   itself — the iframe loads showing "Disconnected".
2. **MeshCentral's OWN in-iframe Connect** — a SEPARATE button, inside the iframe, also literally labeled
   "Connect" (top-left of MeshCentral's own toolbar). Playwright reaches it fine even though
   `mesh.spaceworker.top` is a different origin from `spaceworker.top` — **Playwright drives the browser at
   the CDP level, not via in-page script, so cross-origin iframes are NOT a blocker** the way an in-page
   `document.querySelector` into a cross-origin iframe would be. Locate via
   `page.frames().find(f => f.url().includes("mesh.spaceworker.top"))`, then
   `meshFrame.getByRole("button", { name: /^connect$/i }).first().click()`. After this, the toolbar reads
   "Disconnect | Connected" and the real remote desktop starts rendering.
3. **The "Input" checkbox (`#DeskControl`)** — this IS the actual control-vs-view-only toggle the owner
   described ("I still have to click control separately"), confirmed live. It's a plain checkbox, unchecked
   by default even when the URL already carries control-level rights.
   `meshFrame.locator("#DeskControl").check()` works. **Caution found live**: using `{ force: true }` on this
   check may risk landing a stray click on the desktop canvas underneath (a context menu appeared on the
   real desktop mid-test) — for the real build, verify the checkbox is genuinely actionable WITHOUT `force`
   first (wait for it to be visible/stable), and only fall back to `force` if truly necessary, to avoid ever
   sending an unintended click to the live desktop.
4. **Screenshot** — a plain `page.screenshot()` once the frame has settled (a few seconds after step 2)
   captures the real, live remote desktop. Confirmed: got a genuine desktop image back (icons, wallpaper,
   taskbar, real file names) — proves the whole pipeline works, not just isolated pieces.
5. **Clean disconnect — the important discovery**: the visible "Disconnect" element
   (`<div class="cmtext" onclick="cmdeskaction(11,event)">Disconnect</div>`) is NOT independently clickable —
   it lives inside a menu that isn't open by default, and Playwright's own actionability check fails on it
   ("element is not visible") even after trying to open likely menu triggers. **The reliable fix: call
   MeshCentral's own exposed JS function directly, bypassing the UI entirely**:
   `meshFrame.evaluate(() => cmdeskaction(11, null))`. Confirmed live — toolbar cleanly returns to
   "Connect | RDP Connect | Disconnected", screen goes black, no dangling session. This is MORE reliable than
   DOM-clicking a menu item and should be the actual disconnect mechanism in the real build, not a fallback.

**This resolves the original open question entirely: the whole flow is automatable with zero manual clicks,
and the Disconnect side is actually simpler and more robust than expected (a direct function call, not
UI-dependent).**

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

## Phase 1 — automated capture (CONFIRMED sequence, 2026-09-27)
Playwright drives SpaceWorker's own console page exactly like the live investigation above proved:
1. Headless Playwright (Chromium) with a real minted session — mint the same way `lib/auth.ts`'s
   `createSessionToken` does (or, better, call the real login flow / reuse an internal minting helper — decide
   the cleanest non-hacky way to get a session for the sweep's own service context, since the investigation
   script minted one directly with `SESSION_SECRET`, which is fine for a one-off test but the real sweep needs
   its own clean, auditable way to act as "the system," not literally forge a user token by hand each run).
2. `goto("/console/<deviceId>")` → click our own Connect (`getByRole("button", {name: /^connect$/i})`).
3. Find the `mesh.spaceworker.top` frame → click ITS OWN Connect button (same role/name query, scoped to the
   frame) → wait for it to report "Connected".
4. Check `#DeskControl` (the Input/control toggle) — verify actionable without `force` before falling back to
   it, to avoid a stray click landing on the live desktop.
5. `page.screenshot()` once settled (a few seconds after step 3).
6. Disconnect via `meshFrame.evaluate(() => cmdeskaction(11, null))` — NOT DOM-clicking, this is the reliable
   path (proven, see above).
7. Close the Playwright context/browser.
8. Runs on a systemd timer (same pattern as `automations-sweep`/`digest-sweep`), per opted-in device.
9. Store frames as files (object storage or local disk path referenced by a new `DeviceScreenshot` row) — never inline base64 into Postgres.

This reuses 100% of the existing, already-working Connect flow and auth — no new MeshCentral-side integration, no new trust boundary. The tradeoff: it's a real (if headless) browser session per capture, so it inherits whatever visible "someone is connected" indicator the manual flow already has — this was NOT verified during the investigation (no way to check the actual OS-level agent indicator from outside the VM) and remains a real open question below.

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
- Playwright is confirmed NOT a project dependency yet (installed manually, scratch-only, for this investigation). Add it as a real dependency (`npm install -D playwright` or similar) and check `npx playwright install --with-deps chromium` is run as part of the VPS setup/deploy (it downloads a real browser binary, ~300MB — decide if that belongs in the deploy tar or a one-time manual VPS install step, same category as the worker's Python venv).
- The visible "someone is viewing your screen" / active-session indicator was NOT verified during this investigation (no way to observe the VM's own screen from outside it in this pass) — verify directly before treating captures as background/invisible.
- How to mint the sweep's own session cleanly (see Phase 1 step 1) — not a hand-forged token per run.
- Where do raw frames live (object storage vs. local disk vs. Postgres bytea) — no existing image-blob storage pattern in this repo to copy from; TASK_31's themed-template Flux images might be the closest precedent to check.
- Exact vision model / cost per summary call, weighed against the existing per-user daily AI cap.

## Acceptance (Phase 1/2, once built)
- A real opted-in test device produces real captured frames across a real day (or a compressed test window) via the automated Connect-and-screenshot flow, one real AI summary is generated and delivered via Telegram, disabling the per-device toggle stops captures with zero errors, and an offline device during a scheduled capture never breaks the sweep for other devices.
- Phase 3 has NO acceptance criteria yet — it doesn't get scoped until Phase 1/2 ship and the user explicitly asks to proceed.

## Built 2026-09-27 — Phase 1 is IMPLEMENTED (capture only)

Branch `agent/task-127-device-screenshots`. **Phase 2 (vision summary) and Phase 3 (control) are still NOT built.**

**What shipped**
- `lib/device-screenshots.ts` — the whole pass: the four settings, the per-device due list, governor admission, the slot-holding `capturing` row, outcome recording, reaping and retention. The browser is **injected**, so all of this is testable without Chromium.
- `browser-capture/capture.ts` + `browser-capture/server.ts` — the proven Playwright sequence of "Live investigation" above (both non-obvious findings kept verbatim) behind a tiny loopback HTTP service on **127.0.0.1:3403**, Bearer `SCREENSHOT_CAPTURE_TOKEN`.
- `app/api/internal/screenshot-sweep/route.ts` — the sweep (bearer oneshot, exactly like `governor-sweep`). Owns every database touch and mints the owner's console session.
- `app/api/admin/screenshots/route.ts` — GET/PATCH the four dials plus a live read-out (capturing / captured / failed / opted-in devices / last frame).
- `app/api/devices/[deviceId]/screenshots/route.ts` (+ `/[frameId]`) — per-device opt-in, recent frames, on-demand delete, and the frame image itself (owner-scoped, `private, no-store`, traversal-guarded).
- **The two surfaces an owner actually uses.** Admin panel → *Infrastructure* → **Device screen monitoring** (master switch, the three dials, and a live read-out that states plainly when nothing can be captured because no device is opted in yet). Device console → *Summary* → **Screen monitoring** card (this device's own switch, what the policy currently is, and thumbnails of stored frames that open in place). Both are consistent with the existing panels (the admin card is modelled on `GovernorPanel`); this was a real gap — the APIs existed with no way to reach them, which would have made OWN-9 impossible to perform.
- `prisma/migrations/20261008000000_task127_device_screenshots` — `DeviceScreenshot`, one per-device opt-in column, four `AdminSetting` dials.
- `deploy/screenshot-capture.service` (long-running), `deploy/screenshot-sweep.{service,timer}` (oneshot + 1-minute timer).
- `tests/device-screenshots.test.ts` — 20 tests, all against the REAL module and the REAL governor through the house require hook.

**The two constraints that dictated this shape — do NOT "simplify" them back out**
1. `lib/` is **never shipped to the VPS**: the deploy tar is `.next node_modules package.json package-lock.json prisma browser-server worker deploy`. A standalone worker could not import it (this is the same fact recorded under DEPLOY-1 in the pipeline tracker).
2. Several `lib/*` modules `import "server-only"`, whose default entry **throws** in a plain Node process — so shipping `lib/` would not have helped either.

Hence: **orchestration in the app, browser in its own process, talking over loopback.** Everything the browser needs — the console URL, the minted cookie, the output path — arrives as a request field, so the service holds no database and no secret of its own (only the shared token), and the app holds no browser footprint. `browser-capture` was added to the deploy tar for exactly the reason `browser-server` and `worker` are already in it.

**The cap, and how the owner's "test what 1 does to the RAM" is done**
`screenshotCapturesMaxConcurrent` (default **2**) is enforced by TASK_105's governor as a new queueable feature `deviceScreenshots`, whose live count **is** the number of `capturing` rows. Consequences that are all tested: the cap binds even with the governor's own master switch off; a worker that dies is reaped (5-minute stuck threshold) which frees the slot; a re-ask reuses one durable queue row per device; and a device already capturing is never asked twice. To measure one capture, set the cap to **1** in the admin panel — no code change.

**Deploy recipe (owner-run)**
1. **One-time on the box:** `sudo npx playwright install-deps chromium`, then create `/var/spaceworker/ms-playwright` and `/var/spaceworker/screenshots` owned by `trmm`, then `sudo -u trmm PLAYWRIGHT_BROWSERS_PATH=/var/spaceworker/ms-playwright npx --prefix /opt/spaceworker playwright install chromium`. The browser binary (~300MB) is deliberately **not** in the deploy tar — same category as the worker's Python venv.
2. **Add `SCREENSHOT_CAPTURE_TOKEN=<long random>` to `/opt/spaceworker/.env`.** The app and the capture service must share it. Unset means the service refuses every request, and the sweep records `capture_service_token_not_set` on the row rather than silently doing nothing.
3. Normal deploy (the tar now includes `browser-capture`), then the usual `prisma migrate deploy` → `prisma generate` → restart. The migration is additive.
4. `cp deploy/screenshot-capture.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now screenshot-capture.service`, then the sweep units: `screenshot-sweep.service` + `systemctl enable --now screenshot-sweep.timer`.
5. **Turn it on:** admin **Screenshots** card → enable, cap **1**; then opt ONE device in from its own console. With both switches at their defaults nothing has changed on the box at all.

**Still owner-run — cannot be proven from this repo**
The Playwright sequence itself, and the RAM cost of one capture. **Every test here fakes the browser** (it is injected by design), so nothing in CI touches MeshCentral. Tracked as **OWN-9**.

**Open questions from the previous revision — status**
- *Playwright as a real dependency / browser install:* **resolved** — now in `dependencies` (`^1.63.0` when installed); the binary is a one-time VPS step (recipe step 1), not in the tar.
- *"Mint the sweep's own session cleanly, not a hand-forged token per run":* **resolved** — the route calls the app's own `createSessionToken`, the same call the login route makes. Used once, held in memory, never logged or persisted.
- *Where raw frames live:* **resolved** — files under `SCREENSHOT_BASE_DIR` (production default `/var/spaceworker/screenshots`); rows store a **relative** path; never base64 in Postgres. `assertSafeFramePath` guards every read, write and delete, so a stored path can never address a file outside the root.
- *TASK_31's image-storage precedent:* **checked — it does not exist in SpaceWorker.** This is the first frame store in this repo, so it was designed on its own merits (outside the app dir, so `next build` can never choke on it and it can never be served as a static asset).
- *The "someone is viewing your screen" indicator:* **still open, and it is a product/consent question, not a technical one.** Nothing in this build hides it — every capture is a real session that the device's own agent may surface to whoever is sitting at it. The per-device switch is the consent boundary that exists today; the admin switch alone never captures anything.
- *Vision model and cost per summary:* **still open — that is Phase 2.** When it lands it must go through `lib/agent.ts`'s metered path (`AiUsageLog` / `aiDailyCapHundredthsCent`), and it must be **one call per device per day over that day's frames**, never one call per frame.

**Acceptance status for Phase 1**
Built and unit-proven here; the two clauses that need a live box (a real opted-in device producing real frames, and an offline device never breaking the sweep for the others) are **OWN-9**. The offline clause is already covered by a test at the "due list" level — an offline device is skipped, not failed, and gets no row at all.

