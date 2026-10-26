# TASK_243 — open your cloned browser anytime (relay, SpaceWorker IP, or US/CA exit)

Branch: `agent/task-242-clone-setup-offline` (continues from `fe8b0fb`).
Status: implemented + verified locally. **Not deployed.**

## What the user asked for

- Access the cloned browser **anytime the PC is on** (same IP via relay) and
  **even when it is off** (SpaceWorker's IP, or a US/CA exit route "just how the
  private browser works").
- **Both egress options selectable**, plus the exit routes.
- A **relay clone must stop when the relay goes off** — never linger on a dead
  proxy.
- The clone's **sign-in must survive** so signed-in sites keep working offline.
- **Fix "Carry my session"** (it was broken for hosted clones).
- Re-open the same clone later without it expiring mid-use.

## What was wrong

1. **Direct/exit clones could not start with the PC offline.** `stepRequested`
   required the source to be online for *every* clone. But a hosted clone with
   direct/exit egress captures nothing (route 3), so the PC is irrelevant.
2. **Cookies died with the session.** A live capture was held in RAM for 5
   minutes and injected once; a later clone had nothing to inject.
3. **Carry-my-session broke on hosted clones.** `captured → stepTransfer` failed
   `no_engine_clone_id` (there is no engine bundle), and the session row update
   could throw before the row existed.
4. **Idle TTL expired clones while in use.** The 60-min idle clock was fixed at
   launch and never refreshed by the open window.
5. **A relay clone outlived its relay.** The control tunnel could drop while the
   `active` job and session record stayed.
6. **Launch errors were flattened.** Every failure became
   `launch_exit_unknown`, hiding `relay_offline` / `exit_egress_unverified`.

## What changed

### 1. Three egress choices, validated end to end
- `lib/clone-transport.ts`: `CloneEgress = "relay" | "direct" | \`exit:${string}\``.
- `requestClone` accepts `exit:<id>`, validates it via `getExitNode`, and refuses
  an exit route for a workstation destination (it needs the hosted browser).
- `runHostedLaunch` builds `proxyServerValue = socks5://host:port` for an exit
  node and **proves the exit IP** through the proxy before handing over the
  session (`exit_egress_unverified` tears it down otherwise).
- API `POST /api/devices/[id]/clones` accepts `exit:*`; UI picker shows the
  configured routes from `cloneSetupStatus.exitNodes` (US/CA/UK).

### 2. Durable, encrypted cookie jar
- New `lib/clone-cookie-jar.ts`: AES-256-GCM (same secret as Mailbox) at
  `cookie-jar.enc`, mode **0600**, in the per-target state cache dir, keyed by
  **(device, browser, profile)** — never by a session.
- `clone-capture` route persists the jar after a capture (best-effort).
- `injectLiveCapture` falls back to the jar when the in-memory payload is gone
  (expired, or a clone started while the PC is off), and the session-count
  update is non-fatal.
- `loadCookieJar` never throws: unknown profile / missing base dir ⇒ `null`.

### 3. Source gate scoped by what the clone actually needs
- `needsSourceOnline = relay || !hosted || (live && !jarAvailable)`.
- Hosted + direct/exit + PC offline ⇒ start normally.
- Hosted + live + PC offline + **no jar** ⇒ fail with the named
  `no_saved_session: …` reason (instead of waiting forever).
- Hosted + live + PC offline + **jar** ⇒ `ready`; launch injects the jar.
- Hosted + fresh + PC offline ⇒ skip `collectProfileState`, still `ready`.

### 4. Carry-my-session fixed
- `PIPELINE_NEXT.captured = ["transferring", "ready"]`.
- `captured` + hosted + live ⇒ straight to `ready` (skips the engine transfer).
- `recordLiveCapture` path unchanged for the normal online capture.

### 5. Re-open anytime
- `GET /api/clones/[id]/session` refreshes `CloneJob.lastUsedAt` /
  `idleExpiresAt` and `HostedBrowserSession.lastUsedAt` on every read while
  active+running (the hard TTL still caps it), and returns the refreshed
  `idleRemainingMs`.
- The launch gate is **tunnel-first**: `isRelayTunnelUp(source)` is authoritative
  (it is the path the browser egresses through); the TRMM agent probe is only a
  fallback/diagnostic. A command-channel blip cannot fail a live relay.

### 6. Relay fail-closed
- New `lib/clone-relay-state.ts`: tri-state `relayTunnelState` (`up` / `down` /
  `unknown`). `unknown` (browser-server hiccup) **never** kills a session.
- `enforceRelayFailClosed()` (in `lib/clone.ts`) stops and marks `failed` any
  `active` relay job whose tunnel is provably `down` (`relay_lost: …`), wired
  into `POST /api/internal/clone-sweep` (5-min timer). The container's proxy
  listener already rejects new streams immediately; this closes the record.

## Behaviour matrix (hosted destination)

| Egress | Session | PC online | PC offline |
|---|---|---|---|
| relay | fresh/live | works (tunnel-first gate) | **stops** (fail-closed) |
| direct | fresh | works | **works** (SpaceWorker IP) |
| direct | live | works (fresh capture) | works **from jar**, else `no_saved_session` |
| exit:us/ca/uk | fresh | works | **works** (exit IP proven) |
| exit:us/ca/uk | live | works (fresh capture) | works **from jar**, else `no_saved_session` |

## Verification (local)

- `tsc --noEmit`: clean.
- ESLint on all changed files: clean (the repo's 75 pre-existing errors in
  untouched files are unchanged; the one `clone-session-view` effect warning is
  pre-existing at HEAD).
- New `tests/task-243-clone-anytime.test.ts`: 5/5 — relay tri-state, jar
  round-trip + 0600 + corrupt/absent, jar-fallback injection, fail-closed with
  no jar.
- Focused clone tests: 22/22.
- Full suite: **1811 tests / 1803 pass / 7 fail / 1 skip** — exactly the known
  baseline failures (move-to-private ×5, TASK_179 ×2).

## Deploy notes / risks

- No schema migration: `CloneJob.egressMode` is already `String`; `exit:*` fits.
- Requires `EXIT_NODE_US` / `EXIT_NODE_CA` (and optionally `UK`) in
  `/opt/spaceworker/.env`; `cloneSetupStatus.exitNodes` only lists configured
  nodes, so an unset node is simply not offered.
- The jar lives in `BROWSER_PROFILE_BASE_DIR`; it is purged with the target and
  is never logged (counts only).
- Fail-closed runs on the existing 5-min sweep; the proxy listener already
  blocks new traffic the moment the tunnel drops, so the window is bounded.
