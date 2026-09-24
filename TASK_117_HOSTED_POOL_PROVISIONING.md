# Task 117 (bit B7) — CLOSE THE BROWSER CLONE by reusing the Neko private browser

**Repo:** `spaceworker` (+ `vantra` only if the agent/identity path needs it).
**Written:** 2026-09-24. **Status: DECIDED — reuse the existing Neko browser as the
clone destination (owner, 2026-09-24). The ONLY remaining go/no-go is D1: profile
portability into the container. No hosted-PC pool is built.**
**Pipeline:** `PIPELINE_CONSOLE_BROWSER_CLONE.md` (bit **B7**; unblocks B4's
`no_hosted_clone_device` for every account, including one-PC users).

> ## AGENT CONTRACT
> This file is the DEPLOYABLE RULEBOOK for **closing the browser clone**. It exists
> because the previous guidance was wrong in a way that risked a customer's machine.
> **Read the SUPERSEDING DECISION and Profile model sections first:** the clone
> destination is our existing Neko container, not a new hosted PC.

## Owner's directive (2026-09-24) — the misreading this task corrects

> "i dont understand the connection of wilk to sc. they are different devices, sc
> is for testing and wilk is a customer we cant just run test that could trigger
> a popup.. it has to be perfect before doing that.. the design is to clone a
> device browser and open it on our app with the proxy routing through the device"

Three things were being conflated, and two prior documents (`TASK_114`,
`TASK_116`) had already sent the owner down the wrong path:

1. `Sc` is the **test VM**. `WilkSF9` is a **customer's** PC.
2. A **customer device must never** be used as clone infrastructure, a test
   target, or a fallback — a clone action can raise a visible popup on their
   screen. This is now a hard rule, not a preference.
3. The **clone host is OURS.** The design was never "run the copied browser on
   the customer's second PC".

## The design, restated — and confirmed against the code

| Role | Who owns it | Device row | What runs there |
| --- | --- | --- | --- |
| **Device A — work PC** | the customer | `deviceKind "workstation"` | interactive browser `capture` (cookies/keys, DPAPI-decrypted locally); the **relay** (`cmd/relay`, `--addr 127.0.0.1:8118`) so egress is **their IP** |
| **Device B — hosted PC** | **SpaceWorker** | `deviceKind "hosted"` | `receive` → `inject` → `launch`: the copied browser runs **here**, and is streamed into the SpaceWorker UI |

So: the profile is captured on the customer's machine, the relay stays on the
customer's machine (that is what makes the IP theirs), and the **browser itself
runs on our pooled hosted PC**. "Open it on our app with the proxy routing
through the device" — exactly.

Evidence this is the intent, already in the repo:

- `prisma/schema.prisma` — Device A `deviceKind "workstation"` is documented as
  the clone **source** and Device B `deviceKind "hosted"` as the clone
  **destination**.
- `DESIGN_BROWSER_CLONE_UI_AND_FLOW.md` §7 — "**Hosted PC: pooled** (not
  one-per-user) for now — the host is a shared resource. Admin sets the pool cap."
- `PLAN_NOW_ASSISTANT_AND_CYBER_LAB.md` — "hosted clone PCs are **dedicated
  hosted devices**".
- `lib/clone-settings.ts` — `hostedPoolSize` (default **1**), an `AdminSetting`.

## Why the pool is empty (the actual gap)

1. **`deviceKind` is only ever read.** `Device.deviceKind = "hosted"` appears in
   exactly one place, `app/api/admin/clone-limits/route.ts` (a count). Something
   writes it **nowhere**, so `pooledHosts` is permanently 0 and `hostedPoolSize`
   is a dial nothing acts on.
2. **The transport expects an *agent* on the host.** `runCloneReceive` /
   `runCloneLaunch` address the destination by its `vantraAgentId`, which today
   can only come from a customer-side install.
3. **The only installer we shipped is customer-facing and Windows-only.**
   `install-hosted.ps1` is exposed through the per-device "Set up as clone host"
   button — which is precisely how `Sc` came to be marked a clone host, and how
   the "set up a second PC" copy got invented.

**Corollary already true in code and NOT to be "fixed":** a clone can never run
on the machine it captures from (`pickHostedCloneDevice` excludes the source;
`same_device` is refused). That is a permanent rule, not a bug.

## Technical feasibility — checked, not assumed

The earlier claim "a VPS cannot be the clone host (needs a visible desktop
session)" is **false**, and the engine says so itself:

- `runPreflight` documents an explicit branch for "**POSIX hosted servers**
  isolate by ownership and mode (root-owned, 0700…)".
- `pkg/browser/detect.go` resolves the browser from **`PATH` first** ("POSIX dev
  hosts, Chrome for Testing installs") and only then Windows install paths.
- Non-Windows builds exist: `pkg/crypto/dpapi_other.go`,
  `pkg/injection/disk_free_unix.go`, `pkg/injection/injector_posix_test.go`.
- `DESIGN_…` §5: "use **headless clone** on the hosted PC (the engine **already
  launches headless for validation**)".
- And the customer-visible surface already works this way: the existing
  private-browser runs Chromium in a container (`browser-server/`, Neko) and
  streams it into the app.


## SUPERSEDING DECISION — 2026-09-24 (owner): reuse the Neko private browser. Do NOT build a hosted-PC pool.

Owner: *"we already have a neko private browser, isnt that something that can be
spinned up and we route it through the device instead of adding more load to the
system … i just feel one browser is enough for all."*

**Verified in code — this is the architecture the engine was already built for:**

- `michael/browser-clone/engine/cmd/relay/main.go` (header): the relay is *"an
  HTTP(S) CONNECT proxy that **the hosted clone's browser uses as
  `--proxy-server`** so every request egresses from the work PC's public IP."*
- `browser-server/server.ts:225` already bind-mounts an arbitrary host directory as
  Chromium's profile: `` `${session.profileDir}:/home/neko/.config/chromium` ``.
- `browser-server/server.ts:168-185` already appends `--proxy-server=${proxyServerValue}`
  to the launch flags — the exact hook the relay needs. Today it is fed an exit-node
  endpoint (`lib/exit-nodes.ts`, `socks5://…`); a clone would feed it `relayHealth.addr`.
- Therefore **destination browser + egress via the customer's IP + streamed into the
  app already exist** as the private-browser path.
- `pkg/injection/injector.go` already targets a POSIX host — `MountOwner`: *"POSIX
  hosted servers run the agent as root; the desktop user must own the profile or the
  browser cannot read it."*
- `pkg/crypto/password_handler.go` already implements the Linux side of Chrome's
  crypto (`ChromeSalt = []byte("peanuts")`, `DeriveChromeKey`, `v10` values) — i.e.
  the Windows→Linux translation D1 was framed around.

**Consequence:** D2, D3(b) and D4 existed only to *put a browser somewhere and show
the user*, which Neko already does. They collapse into D1. The destination becomes
"a Neko session launched from the clone's injected profile", not a new machine. No
new load: it is the same container type already running.

**Second-order win — single-PC users can finally clone.** The `self_only` refusal
exists *only* because the destination had to be a second PC of the customer's
(`lib/clone.ts`). With our container as the destination, the source device hosts
nothing, so **cloning one PC — exactly what the owner tried from the start — becomes
legitimate.** `self_only` must be retired along with D2.

**The one unproven link (D1, restated precisely):** the container has no OS keyring,
so Chromium must be launched with `--password-store=basic` to derive the same
`peanuts` key the engine writes its `v10` values with. That is a one-line addition to
the existing `flags` array. **Settle this first — it is the whole go/no-go.**


## Profile model — how the clone browser actually runs (owner decision 2026-09-24)

Owner: *"everyone is using a single chrome, we just split each browser profile just
the way chrome works … so we dont risk leakage … maybe it automatically creates a
browser profile with that device name and user can launch it with all the cookies
and others coming from the clone."*

**This is already the codebase's model — the clone reuses it unchanged.**

| Chrome concept | What we already have | Clone use |
| --- | --- | --- |
| A profile (its own cookies/logins) | `BrowserProfile` — `userId`, `name`, `dirPath` (absolute, never exposed), `status` `idle`\|`in_use`, `@@unique([userId, name])` | One profile **per cloned device**, `name` = the device name |
| Opening a profile | `BrowserSession` — `profileId`, `proxyMode`, `exitNodeId`, `containerId`, `nekoPassword`, `exitIpSnapshot` | Launching a clone = a session on that profile |
| One Chromium per profile | `browser-server/server.ts:225` `` `${session.profileDir}:/home/neko/.config/chromium` `` — only that profile is mounted | Isolation is structural: a container can only ever see its own profile dir |
| Egress per session | `--proxy-server=${proxyServerValue}` (server.ts:168-185) | Fed `relayHealth.addr` instead of an exit node → **the customer's IP** |

**So the flow is:** `capture` on the device → inject into a `BrowserProfile` named
after the device → `BrowserSession` on it with `proxyServerValue = relay addr` →
user opens it in the app via the existing `viewUrl` iframe. No new browser, no new
browser engine, no new machine.

### The two blockers found in code (both must be fixed, both are small)

1. **`--bwsi` is already on (server.ts:176 — "browse without sign-in").** A clone's
   entire point is carrying the source's signed-in state, so this flag must be
   verified against a real injected profile and dropped for clone sessions if it
   neutralises the restored cookies. **This is part of the D1 go/no-go.**
2. **`cleanupProfileDir` runs `chmod -R 777` (server.ts:327-341).** Fine for
   throwaway private-browser profiles; **not** fine for clone profiles, which hold
   real credentials — world-readable on a multi-tenant VPS. Clone profiles must be
   `chown`ed to the container's `neko` uid:gid at `0700` instead. (The engine already
   has the concept: `InjectOptions.MountOwner` — *"the desktop user must own the
   profile or the browser cannot read it"*.)

### Everything else that must be considered (so this does not get re-opened later)

- **Injection must not run as root-owned files** the container user cannot read;
  ownership is set at inject time, not papered over with 777.
- **Re-cloning the same device** collides with `@@unique([userId, name])`. Decision:
  **refresh in place** (the profile is "the latest capture of `Sc`"), not `Sc (2)`.
- **One profile = one live session** (`status = "in_use"`, plus Chromium's own
  Singleton lock) — the existing lock is what stops two containers opening the same
  profile and corrupting it. Keep it; do not bypass for clones.
- **Profile location** must stay under `BROWSER_PROFILE_BASE_DIR`
  (`/var/spaceworker/profiles`) — **never** inside the app root. A runtime dir under
  `/opt/spaceworker` is what already crashed `next build` (Turbopack, os error 13).
- **RAM admission** — a clone session is one more container. It must count against
  the *same* caps as the private browser (`TASK_105` governor), or cloning silently
  doubles memory spend. `hostedPoolSize` becomes irrelevant and is superseded by the
  existing `maxConcurrent` / `perUserCap`.
- **`--disable-file-system`** (already on) blocks the File System Access API, so
  site upload/download flows that use it will not work in a clone. Accept or change
  deliberately.
- **TTL + purge (D6)** — clone profiles hold real cookies, so revocation and expiry
  must wipe them: reuse `purgeAfterDays` and the `BrowserSession.hiddenAt`
  soft-delete pattern.
- **Audit** — reuse `BrowserSession.exitIpSnapshot` (written at start from a live
  check) as the record proving a clone really egressed via the customer's device.

### The minimal path to a testable clone

1. **D1 (go/no-go):** Neko container + `--password-store=basic` (drop `--bwsi` if it
   interferes) + a real `Sc` capture injected → signed in to a site it never logged
   into. Settles the cookie question once.
2. Register the clone as a `BrowserProfile` named after the device.
3. Launch it with `proxyServerValue = relayHealth.addr`.
4. Retire `self_only` (moot once the destination is ours).

| --- | --- | --- |
| **D1** | **Profile-portability spike (no UI).** Prove a Windows-captured profile can drive a browser **on the hosted PC**. | THE technical risk. Windows Chrome cookie values are AES-GCM encrypted with a DPAPI-protected key from `Local State`; `capture` already decrypts that locally and re-encrypts for transport (`pkg/crypto/password_handler.go`). Injection must then emit a profile the **host's** browser accepts — either by writing a host-valid `os_crypt` key in `Local State`, or by launching the host browser with `--password-store=basic` and writing matching values. **Done =** a containerised browser on the host, started from a real `Sc` capture, is signed in to a test site it never logged into. If this fails, D2+ are re-planned before more is built. |
| **D2** | **Clone-backed Neko session (replaces the hosted-PC pool).** Per-clone Neko container whose `profileDir` is the injected clone profile and whose `--proxy-server` is `relayHealth.addr`. No `Device` row, no system tenant, no `install-hosted.ps1` on a Windows box. | `hostedAvailable` becomes meaningful with **zero** new hardware, and a single-PC account can clone. Retire the now-moot `self_only` refusal. |
| **D3** | **Egress through the customer's device.** Point the container's `--proxy-server` at the customer's relay (agent-forwarded port, since the relay is loopback-bound and replayed over the Mesh tunnel). | The only part of the old D3 left. **Done =** a clone in relay mode reports the **customer's** IP, and aborts when the relay is down (`relayRequired`). |
| **D5** | **UI truth-telling.** "Set up as clone host" stops being a customer-facing task; the clone tab reports **hosted-pool status** instead. | This is the fix for the misconception that caused this task. The copy in `TASK_116` already stops instructing users to provision hardware; D5 finishes the job by moving the button to an ops surface. |
| **D6** | **Lifecycle.** TTL/teardown/purge for hosted sessions + `TASK_105` governor integration so RAM caps and queueing apply to the pool like every other high-RAM consumer. | `hostedPoolSize` is a RAM dial; the governor owns RAM admission. |

## D1 FINDINGS — measured on the VPS 2026-09-24/25 (device-free: no VM, no customer device)

Environment: **chromium 151.0.7922.71** (Debian 13) from
`ghcr.io/m1k1o/neko/chromium:latest`, launched through the **Neko entrypoint on
real Xorg**, profile bind-mounted exactly as production does (`browser-server`).

### F1 — CONFIRMED BUG: the engine's Chrome key salt is wrong

`michael/browser-clone/engine/pkg/crypto/password_handler.go`:

- `ChromeSalt = []byte("peanuts")`, and `DeriveChromeKey(p)` calls
  `PBKDF2SHA1([]byte("peanuts"), p, 1, 16)` — i.e. it passes **`peanuts` as the
  PBKDF2 salt**.
- Chromium's Linux derivation is
  `PBKDF2-SHA1(password="peanuts", salt="saltysalt", iterations=1, keylen=16)`.
- **Proof:** with salt `"saltysalt"` the engine's own PBKDF2 cleanly decrypts a
  cookie **Chromium 151 wrote** — valid PKCS7, structured plaintext,
  `VALUE="CHROMIUM-WROTE-THIS"`. With salt `"peanuts"` the same blob decrypts to
  garbage.
- The engine's PBKDF2 implementation is **not** at fault: it matches Python's
  `hashlib.pbkdf2_hmac` byte-for-byte
  (`bd041144f77dd5078c78071bbed1d45e`) and passes the RFC 6070 vectors its own test
  asserts. **Only the salt is wrong.**
- Impact: any POSIX/hosted path that reads a Linux profile's cookie DB. The Windows
  path takes its key from DPAPI and is unaffected.

### F2 — CONFIRMED BUG: the 16-byte cookie prefix is not handled

A Linux cookie plaintext is `<16-byte prefix><value><PKCS7>`, not
`<value><PKCS7>`:

- Decrypted ciphertext = `db872090732c96aa5df1d83cb1f3e85a` +
  `"CHROMIUM-WROTE-THIS"` + 13×`0x0d`.
- The prefix is **host-scoped, not per-cookie**: two cookies for the same host had
  the *identical* prefix despite different names and values; it is also not
  `SHA256(host)`/`MD5(host)`.
- `DecryptChromeValue(..., stripV10=true)` returns the whole plaintext, so the
  prefix would be returned as part of every cookie value.

### F3 — persistence works, but only with a real display

- With `--password-store=basic` on **real Xorg**, Chromium persisted its cookie and
  **sent it again after a full container restart** (PASS).
- Under `--headless=new` the same test wrote **0 rows** on every attempt — headless
  is not representative for cookie work.
- `Local State` contains **no `os_crypt`** in this container (no keyring), which is
  consistent with the hardcoded-password path.

### F4 — DECISIVE: Chromium discards cookie rows it did not itself write

Out-of-band SQLite writes do **not** survive Chromium:

- Rows injected with attributes cloned byte-for-byte from Chromium's own row
  (only `name` + `encrypted_value` changed) → **deleted** by Chromium.
- Control: `swcopy` = **Chromium's own blob, verbatim**, same attributes, only the
  name changed → **also deleted**, while the originals `swa`/`swb` were kept and
  sent on the wire.
- Therefore **disk-level cookie injection is not a viable mechanism.** Chromium
  holds cookies in memory and rewrites the store, dropping rows it does not accept
  at load. This is the finding that decides the architecture.

### F5 — the runtime path is reachable

- `--remote-debugging-port` is **ignored when `--user-data-dir` is the default
  profile dir** (this is why the first attempt silently had no endpoint). With a
  non-default dir: `DevTools listening on ws://127.0.0.1:9222/…`, and
  `/json/version` returns `Chrome/151.0.7922.71`.
- DevTools binds **container-loopback only** — `--remote-debugging-address` is
  ignored — so a published Docker port cannot reach it. The image ships no
  `socat`/`nc`, so we ship our own static forwarder
  (`swfwd 0.0.0.0:9223 127.0.0.1:9222`, ~3.4 MB Go, built on the same cross-compile
  path as the engine). With it, the DevTools **HTTP** endpoint is reachable from the
  host.
- DevTools advertises its **internal** ws URL, so a client must rewrite
  `ws://127.0.0.1:9222/...` to the forwarded port.
- **RESOLVED 2026-09-25 — the working recipe is in F6.** The earlier "handshake does
  not complete" was a **client-side artefact**, not a Chromium problem: `curl` and a
  raw `http.request` upgrade both get `HTTP/1.1 101` immediately, through the
  forwarder *and* directly inside the container. Node's built-in `WebSocket` hung
  because the post-upgrade socket stays **corked** — writes buffer and never reach
  the wire (fixed with `socket.uncork()`). That fix exposed the real gotcha in F6.

### F6 — THE WORKING RECIPE (D1 mechanism proven end-to-end)

Measured 2026-09-25 on the VPS, **no device involved**.

1. Launch the clone container with a **non-default `--user-data-dir`**, plus
   `--remote-debugging-port=9222 --remote-allow-origins=*`. Run a loopback
   forwarder beside it (`swfwd 0.0.0.0:9223 127.0.0.1:9222`) and publish that port.
2. Connect to the **browser** endpoint — `/devtools/browser/<id>`.
3. **`Storage.setCookies`** — a **browser-level** method that needs **no attach**.
4. `Target.createTarget {url}` (or `Page.navigate`) to open the page.

**Do NOT use:**

- a direct `/devtools/page/<id>` socket: it completes the handshake and answers
  **ping/pong**, but **silently ignores every DevTools command** — no reply, no
  error, no close. This is the trap that looked like a broken handshake.
- `Target.attachToTarget`: returns `{"code":-32000,"message":"Not allowed"}` here,
  so the usual "attach then session-scope your commands" pattern is unavailable.

**Proof (the go/no-go):**

```
Storage.setCookies = {}
Storage.getCookies(swcdp) = ["172.17.0.1/=CDP-STORE-1790290938"]
Target.createTarget = {"targetId":"01A45FF7CD254A531FBB190A020C16DA"}
--- server log ---
path=/cdptest COOKIE_HEADER='swcdp=CDP-STORE-1790290938'
```

The renderer presented the CDP-injected cookie on its first request.

**Persistence:** after a full container restart,
`Storage.getCookies` listed `swcdp@172.17.0.1` at startup and the page sent it
**without re-injection** — Chromium had written it to disk itself. So injection can
be once-per-profile; re-injecting every launch is the safe default.

**Transport note:** the entire path was driven **from a laptop over an `ssh -L`
tunnel** — no agent, no browser, and nothing installed on the clone host. Injection
is a server-side operation.

### Consequence for the build (supersedes the earlier "minimal path")

Given **F4** — and now **proven end-to-end in F6** — the clone receives its cookies
**at runtime, through Chromium** (CDP), not by writing the profile. That means:

- a clone session must launch with a **non-default `--user-data-dir`** plus remote
  debugging (F5), and therefore a forwarder;
- the cookie payload is delivered **per launch**, and Chromium persists what it is
  given (proven: the cookie survived a full container restart, F6), so both
  "inject once" and "re-inject every launch" work;
- and it unlocks what the disk path could never do — **localStorage /
  sessionStorage**, where many sites actually keep auth state.

**F1/F2 remain real bugs to fix** so the capture side can read a Linux profile
correctly, but they are **no longer on the critical path** for launching a clone.

## Non-negotiable guardrails

1. **A customer device is never clone infrastructure.** Not a clone host, not a
   test target, not a fallback, not a probe. `WilkSF9` specifically: no clone,
   no setup click, no experimental command — a clone can raise a visible popup on
   a customer's screen, so it must be perfect first.
2. **Test on `Sc` (the test VM) and on the hosted pool. Nothing else.**
3. **A customer device still never hosts.** The `self_only` *hosting* rule stays —
   a device may not host its own clone — but that refusal becomes **unreachable**
   once the destination is our container, so **cloning a single PC is allowed and
   expected.** Do not reinstate a second-PC requirement.
4. **No new customer-facing button may instruct a user to provision hardware we
   are supposed to own.** If copy needs to name a fix, it must name a
   SpaceWorker-side action.

## Verification

- **D1 mechanism PROVEN (see "D1 FINDINGS" → F6); the `Sc` capture remains.** Proven
  without any device, on the real Neko container: the transport works (F5), the
  engine's KDF salt and cookie-prefix handling are wrong (F1/F2), disk injection is
  impossible because Chromium deletes foreign rows (F4), and — the go/no-go — a
  cookie injected via `Storage.setCookies` **was received by the site on the wire**,
  and **survived a full container restart** (F6).
  Still to prove: a **real capture from `Sc`** showing a signed-in site inside the
  clone. That requires the device, so it waits for the owner — nothing else in D1 is
  outstanding.
- D2 proved by: a clone launches a Neko session from the injected profile, and a
  **single-PC** account can clone with no second device involved.
- D3 proved by: relay-mode egress reports the **customer's** IP, and the launch
  **aborts** when the relay is down (`relayRequired`).
- D5/D6 proved live, then re-tested against a fresh `Sc` console.
- Every step: never touch `WilkSF9`.

## Decisions — recorded 2026-09-24

- **Q1 — DECIDED: (a) a Linux container on our VPS.** Owner: *"hosted pc as a linux
  container, it will be light weight. and it goes with the queue system we have to
  manage resource."* This matches the codebase: the private browser already runs
  Chromium in a Neko container streamed to the user, `hostedPoolSize` is already an
  admin dial (default 1), and `TASK_105_RESOURCE_GOVERNOR_QUEUE.md` +
  `DESIGN_…` CROSS-TRACK RULE 7 own admission control — so pooled sessions are queued
  and RAM-capped exactly like every other high-RAM consumer instead of bypassing the
  governor. **D1 remains the go/no-go gate** before D2 is built.
- **Q2 — EXPLAINED (not a design change).** Owner: *"if we do headless how do we use
  the cloned browser, users need to be able to use it physically."* **Headless
  describes our side only** — no monitor/keyboard on the hosted PC. The user still
  gets a full, physical, clickable browser: `components/clone-session-view.tsx`
  already renders the session as `<iframe src={openUrl}>` filling the window
  (clipboard allowed), where `openUrl` = `BrowserSession.viewUrl` stamped at launch
  (`app/api/clones/[cloneId]/session/route.ts`). Same pattern as the private browser
  the owner already uses. Nothing about the user experience is "headless".
- **Q3 — EXPLAINED.** Owner: *"what happens when we drop the customer facing set up.
  whats the issue with that"*. Answer:
  - **Nothing breaks for customers.** The host is ours, so "Set up as clone host"
    stops being a customer task and becomes server-side (D2). Removing the button
    removes the trap that produced this whole misreading — the owner set `Sc` up as
    clone host and was still refused, because one PC can never host its own clone.
  - **The source button stays.** "Set up this PC" (engine + relay on the customer's
    own machine) is REQUIRED by the design — it is what routes egress through the
    customer's IP. Only the *host* button moves to an ops surface.
  - **What we lose:** the ability for a customer to nominate their own second PC as
    a host ("bring your own host"). If that is ever wanted as a perk for spare
    machines, it comes back deliberately — it is not a default capability.
  - **RESOLVED — no longer an open question.** It assumed the host would be a
    customer PC. With the destination being **our container**, a device never hosts
    anything, so existing `clone-host` flags become irrelevant rather than something
    to honour. `self_only` is retired with them (see the superseding decision above).
- **Q4 — DECIDED (owner, later the same day): do NOT build a second browser.**
  *"we already have a neko private browser, isnt that something that can be spinned
  up and we route it through the device instead of adding more load to the system …
  i just feel one browser is enough for all."* Verified correct against the code —
  the relay documented its consumer as "the hosted clone's browser … `--proxy-server`",
  and the Neko container already mounts an arbitrary profile dir and already sets that
  flag. See the two sections above for the profile model and the two code blockers.

## Live finding while deploying this (2026-09-24) — runtime dirs inside the app root break `next build`

Found the hard way: a copy-only deploy silently produced a **stale `.next`** because
the build aborted. Root cause:

- `BrowserProfile.dirPath` is stored **absolute in the DB**. The env var
  `BROWSER_PROFILE_BASE_DIR` had already been moved to `/var/spaceworker/profiles`,
  but the two existing rows still pointed at
  `/opt/spaceworker/browser-profiles/<id>` — and `app/api/browser-sessions/route.ts`
  forwards `profile.dirPath` verbatim to `browser-server`, so the live Neko container
  kept bind-mounting the profile **from inside the app root**.
- `browser-server` computed its own dir at `resolve("browser-sessions-tmp")` →
  another runtime dir inside the app root.
- Chromium/container-created files are **owner-only (0600, owner `ubuntu`)** while the
  build runs as `trmm`, so Turbopack — which indexes the project root — died on:
  `raw_read_dir failed … reading dir ".../blob_storage/<guid>" … Permission denied (os error 13)`.

Fixed and verified live:

1. Moved `browser-profiles/` → `/var/spaceworker/profiles/` and `browser-sessions-tmp/`
   → `/var/spaceworker/sessions-tmp/` (older duplicate parked in
   `/root/backups_runtime-<ts>/`); the live session had already ended, so nothing was
   disturbed — **no customer device involved**.
2. Repointed both `BrowserProfile.dirPath` rows into the configured base. This also
   fixes a latent bug: `deleteProfileDir()` calls `assertSafePath()`, which throws for
   any path outside `BASE_DIR` — so **deleting those profiles was failing** before this.
3. `browser-server`: `SESSION_TMP_DIR` now honours `BROWSER_SESSIONS_TMP_DIR`, else
   derives `sessions-tmp` **beside** `BROWSER_PROFILE_BASE_DIR`, exactly like the
   profiles base. cwd-relative fallback kept for local dev.
4. `.gitignore` gained `browser-profiles/` + `browser-sessions-tmp/` as defence in depth.

Verified: build `✓ Compiled successfully in 17.4s`; a session started with both the
direct and proxy paths mounted **from `/var/spaceworker/…`** (not the app root);
stop clean; containers gone; app root free of both dirs.

**Rule going forward:** no mutable runtime state inside the app dir. Anything the
services write at runtime must live outside `/opt/spaceworker` (or the build can be
broken by a file the build user cannot read).

## Rollback

Nothing in `TASK_116`/this scope changes existing customer behaviour: the pool
stays empty until D2 lands, and the console copy now describes that state
truthfully instead of asking a user to build us a server.
