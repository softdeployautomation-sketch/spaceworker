# Task 135 — Browser Clone: why it carried no session, and the state-carry model

**Status: the session-carry BLOCKER is fixed in this change** (TASK_119A A4's CDP
endpoint, never built — see §1.1). Tab/session files and source-version detection
are added. The version-matched hosted browser (§4) is designed here and is the
next build.
**Written:** 2026-09-28, after a full read of TASK_117 / TASK_118 / TASK_119A/B
and the merged code. Owner report being answered: *"the cookies or history or
other dependencies for this feature doesn't seem to work"*.

---

## 1. Why it looked broken — four separate defects

The feature is not one thing. It is a session carry AND a state carry, and the
two were failing for different reasons.

### 1.1 BLOCKER — the hosted browser had no CDP endpoint, so `live` ALWAYS refused

A `live` clone delivers the captured cookies by injecting them into the running
hosted browser over the DevTools Protocol. Nothing about that path existed on the
hosted side:

| Evidence | What it means |
|---|---|
| `browser-server/server.ts` had no `--remote-debugging-port`, no forwarder, and `/sessions/start` never returned `cdpPort` | there is no endpoint to inject through |
| `lib/clone-hosted-launch.ts:185` refuses when `cdpPort` is missing (`session_injection_failed: CDP endpoint not available`) | **every** `live` clone failed at launch, by design — fail-closed, so it never silently produced a sessionless clone |
| `HostedBrowserSession.cdpPort` exists in the schema and was never written | the column has been unfilled since TASK_118 |
| TASK_119A **A4** specifies exactly this work (`cmd/swfwd`, mount + supervisord, `-p 127.0.0.1:<port>`, stamp `cdpPort`) | it was specified and never implemented |

So the capture route, the ingest route, the injection module and the UI selector
were all built and correct — and the last step, the endpoint they all deliver
through, was missing. That is the whole of "the cookies don't work" in `live`.

### 1.2 The disk-file route for cookies/logins is dead by design on Chrome/Edge/Brave 127+

Not a bug and not something version-matching can fix. From this repo's own
measured findings (`TASK_117` §D1):

- **F10** — 127+ cookie values are App-Bound-Encrypted (`v20`); the key is
  released only to a path-validated browser process, so **no** out-of-process
  reader can decrypt them.
- **F11** — a *relocated* profile gets a different ABE key, and Chrome then
  **deletes** the rows (staged clone: `cookie_rows=0` vs 85 in the original).
- **F12** — Chrome 136+ ignores `--remote-debugging-port` on the default profile.
- **F4** — Chromium **discards any cookie row it did not write itself**, proven
  by injecting its own blob verbatim under a new name.
- **F6** — `Storage.setCookies` over CDP works, needs no attach, and Chromium
  persists what it is given (survived a full container restart).

Consequence: cookies must leave the source **from inside the browser**
(`chrome.cookies.getAll()` in the extension — TASK_119B) and enter the clone
**through the browser** (CDP). Both halves exist in this repo. §1.1 is why they
were not connected.

### 1.3 The "history / bookmarks / tabs" half was never wired into the hosted path

`runHostedLaunch` deliberately creates a **fresh, empty** profile ("no bundle to
capture/transfer/inject — route 3"). The legacy file pipeline
(`capture → transfer → inject`) still exists for a workstation destination, but a
hosted clone uses none of it. So history, bookmarks, extensions and tabs were
never carried by the product's main path at all.

On top of that, the §2 file set itself had a hole: it had no `Sessions\*` entry,
so even the file pipeline could not have restored tabs. Same for the legacy
root-level `Current Session` / `Current Tabs`.

### 1.4 `--bwsi` was still on for clone sessions

`browser-server/server.ts` hardcoded `--bwsi` ("browse without sign-in") for
every session. TASK_117 listed dropping it for clone sessions as blocker #1 and
it had not been done — a flag whose entire purpose is browsing *without* a
sign-in, on a session whose entire purpose is to carry one.

---

## 2. What this change does

| Fix | Where |
|---|---|
| The CDP forwarder (static, loopback-only target, byte-for-byte pump) | **new** `michael/browser-clone/engine/cmd/swfwd/main.go` + `main_test.go` |
| Launch conf, docker args and profile dir as one tested pure module | **new** `browser-server/chromium-session-config.ts` |
| Golden test: the private-browser conf is **byte-identical** to before | **new** `browser-server/chromium-session-config.test.ts` |
| CDP sessions: non-default user-data-dir + DevTools + `swfwd` program + **host-loopback** publish; `cdpPort` returned | `browser-server/server.ts` |
| `cloneMode`: drops `--bwsi`, adds `--password-store=basic`; fails fast if `swfwd` is missing (`swfwd_binary_missing`) | `browser-server/server.ts` |
| Request `cdp`/`cloneMode` for hosted clones; job read **before** the container starts; `cdpPort` stamped on the session | `lib/browser-launch` → `lib/clone-hosted-launch.ts`, `lib/clone-live-capture.ts` |
| `cdp`/`cloneMode` in the runtime client contract | `lib/browser-runtime.ts` |
| **Tabs**: `Sessions\*` (+ legacy `Current Session`/`Current Tabs`/`Last *`) added to the §2 file set | `michael/browser-clone/lib/ProfilePaths.ps1` |
| **Version detection**: `Get-BrowserMajorVersion` (Chrome/Edge `Last Version`, Firefox `compatibility.ini`), reported as `browser_major_version` + written to `_meta\source-browser.json` | `michael/browser-clone/lib/ProfilePaths.ps1` |
| **Honest refusal** instead of a silent zero-cookie archive on Chrome/Edge 127+ (`unsupported:app-bound-encryption`, exit 1) | `michael/browser-clone/lib/ProfilePaths.ps1` |
| The forwarder ships, hashed, with the rest of the deploy artifacts | `scripts/engine-dist.mjs` (`swfwd-linux-amd64`) |
| Deploy requirements + the new API contract | `browser-server/README.md` |


---

## 3. The corrected model — what can be carried, and how

The owner's instinct ("detect the version, deliver a matching browser, load the
profile files") is **right for everything except cookies and saved passwords**.
Split the payload by what actually survives a machine move:

| Payload | Chromium 127+ (Chrome/Edge/Brave) | Chromium ≤126 | Firefox |
|---|---|---|---|
| History, bookmarks, favicons, autofill (`Web Data`), Preferences | **file copy** ✔ | file copy ✔ | file copy ✔ (`places.sqlite`, `formhistory.sqlite`, `prefs.js`) |
| **Tabs / window state** (`Sessions\*`) | **file copy** ✔ (added here) | file copy ✔ | file copy ✔ (`sessionstore-backups\`) |
| Extensions (+ their state/settings) | file copy ✔, **version-sensitive** | same | file copy ✔ (`extensions.json`) |
| **Cookies / logged-in sessions** | **only in-browser capture → CDP injection** (F10/F11/F12/F4) | file copy may work (`v10`, DPAPI-unwrappable) | **file copy works** — `cookies.sqlite` values are not encrypted |
| **Saved passwords** | only in-browser (ABE); nothing may claim otherwise | DPAPI-decryptable on the source | **file copy works** — `key4.db` + `logins.json` are portable (no OS binding without a master password) |
| Egress identity | relay through the source device (already built, fail-closed) | same | same |

Two consequences worth stating plainly, because they decide the product copy:

1. **A clone is two carries, not one.** State (files) and session (cookies) are
   delivered by different mechanisms and can fail independently. The console must
   report them separately: `files_captured` vs `cookie_transfer`, and a `live`
   clone's cookie count. A clone with 0 cookies is a **partial** clone — which
   `ProfilePaths.ps1` already reported as exit 1, and now names
   (`unsupported:app-bound-encryption`) instead of silently shipping zero.
2. **Firefox is the one browser where the file route carries the session too.**
   Its `key4.db`/`logins.json`/`cookies.sqlite` are already in the §2 file set.
   The hosted side runs Chromium only, though — so a Firefox clone needs a
   Firefox destination to be anything more than a bookmark import (§4, step 3).

### The flow, end to end

```
SOURCE DEVICE (work PC)                              OUR HOST (hosted clone)
───────────────────────                              ───────────────────────
1  detect browser + MAJOR VERSION          ───┐
   Get-BrowserMajorVersion / engine detect    │
2  capture STATE files (§2 set incl. Sessions)│     3  resolve a destination browser
   → encrypted .psa archive                   │        build matching that major
                                              │        version (§4); fail closed
                                              │        when it cannot be matched
                                              │
4  extension: chrome.cookies.getAll()  ───────┼──→  5  launch: non-default
   → device token → POST /api/devices/clone-capture    user-data-dir, DevTools on,
     (counts only; RAM-held, TTL'd, never logged)      swfwd in-container,
                                                       published 127.0.0.1:<port>
                                               └──→  6  restore STATE into the profile
                                                       BEFORE the first launch
                                                     7  CDP Storage.setCookies → the
                                                        clone is signed in
                                                     8  egress = the device's relay
                                                        (fails closed if it is down)
```

Steps 1, 2, 4, 5, 7, 8 exist today (step 4 is TASK_119B's extension + native host;
steps 5 and 7 are what this change connects). **Steps 3 and 6 are the remaining
build** — §4.

### The trigger: why a capture now happens with nobody present (§7)

The popup was the only way a capture could start, which means **a closed browser
or an absent human meant no capture at all** — the feature's core promise ("log in
from anywhere") failed in exactly the case it exists for. §7 is the silent wake
and the self-triggering extension that fix it.

### First-time clone vs sync on reconnect (§8)

Two flows, one rule each: the first clone sends everything, and every later
connect sends only what changed. §8.

---

## 4. Version matching (the remaining half) — design

**Why it is needed at all:** for the *state* files, and only for them. Chromium
refuses or silently migrates a profile written by a **newer** build, and both the
`Preferences`/`Secure Preferences` schema and the extension loader are
version-sensitive. Cookies do **not** need it (CDP delivers them as data, not as
a profile). Fingerprint parity (`--lang`, timezone, UA string) matters for the
same reason the relay does: the clone has to look like the machine it came from.

**Today the destination cannot match anything.** The container image is
`ghcr.io/m1k1o/neko/chromium:latest` — a rolling Debian Chromium (measured at 151
during TASK_117) against a Windows source that may be any version. Nothing reads
the source version and nothing selects a build.

**Design, in the order it must be built:**

1. **Persist the source version on the job.** `Get-BrowserMajorVersion` now
   returns it (`browser_major_version` in the capture JSON, plus
   `_meta\source-browser.json` in the archive) and the engine's
   `pkg/browser.detectVersion` already does the same on the Go path. Add
   `CloneJob.browserMajorVersion Int?` with a hand-written migration (repo
   convention), written by the capture step and read by the launch step.
   `$null` means *undetermined* — never "assume latest".
2. **Resolve a destination build per major version.** A pure module,
   `lib/hosted-browser-version.ts`: `(browser, major) → { build spec, userAgent,
   platform }`, preferring **Chrome for Testing**
   (`googlechromelabs.github.io/chrome-for-testing`), which publishes
   version-pinned linux64 builds for every stable major — so ONE image serves any
   source version by downloading the matching build at container start, instead
   of us building and storing an image per version. Fallback: pinned Neko image
   tags per major version.
3. **Fail closed when there is no match**:
   `browser_version_unsupported: <major>` refuses at launch with a named reason
   and the UI offers `fresh` — the same shape as `session_injection_failed` and
   `relay_offline`. Never a silent downgrade that half-loads a profile. Firefox
   sources get `browser_not_supported` until a Firefox destination exists.
4. **Set parity flags** from the same resolver in the session conf: `--lang`,
   `TZ` (Neko env) and `--user-agent=<source UA>` — the per-session flag plumbing
   added in `chromium-session-config.ts` is where these belong.
5. **Then stage the state files.** A restore step that unpacks the `.psa` into
   the session's profile dir (the CDP path's
   `/home/neko/.config/chromium-clone`, or the default for a non-live clone)
   *before* the container starts, owned by the container user at `0700` —
   **never** `chmod -R 777` (TASK_117's second blocker: that store holds real
   credentials on a shared host). Lock files are already scrubbed by the restore
   path.
6. **Tab restore needs one nudge.** Copying `Sessions\*` is necessary but not
   sufficient: Chromium reopens them only when it believes the previous exit was
   unclean. Set `profile.exit_type = "Crashed"` / `exited_cleanly = false` in the
   restored `Preferences`, or launch with `--restore-last-session`, then verify
   against a real profile. That is the difference between "files present" and
   "tabs open".

**What NOT to build:** reading `Network\Cookies` / `Login Data` off a 127+
device, or "download the portable browser" games to make that work.
F10/F11/F12/F4 are settled, and the capture now names the refusal
(`unsupported:app-bound-encryption`) so nobody re-opens it.

---

## 5. Verification performed (this change)

- `go test ./cmd/swfwd/` — **pass** (a real loopback round-trip through the
  forwarder, plus a table test for the non-loopback refusal). `gofmt -l` and
  `go vet` clean.
- The **built artifact** (`engine-dist/swfwd-linux-amd64`, 2.0 MB) against a
  stand-in DevTools listener: byte-for-byte round-trip, clean `SIGTERM`
  shutdown, and `-target 0.0.0.0:…` refused with exit 2.
- `npx tsx --test browser-server/chromium-session-config.test.ts` — **7/7 pass**,
  including the golden test that a non-clone session's conf is unchanged and the
  assertion that the **host** publish is `127.0.0.1`, never `0.0.0.0`.
- `npx tsc --noEmit` — clean (after `prisma generate`).
- `node scripts/engine-dist.mjs` — **10 artifacts**, `swfwd-linux-amd64` in the
  hashed manifest.
- `pwsh -File michael/browser-clone/tests/Test-Roundtrip.ps1 -WithKey` — every
  check added here passes: `capture.file-list-finds-sessions`,
  `version.major-detected`, `version.unknown-is-null`,
  `capture.reports-browser-version`, `capture.app-bound-refused-by-name`,
  `capture.app-bound-is-partial`. **Two pre-existing checks fail on Linux**
  (`capture.file-list-finds-synthetics`, `restore.manifest-present`): the
  fixtures build `Extensions\abc` with a literal Windows backslash, which is not
  a separator off-Windows. Reproduced identically on pristine `HEAD`, so not
  caused by this change. **Note for that file's owner:** `Check()`'s
  `$failures += $Name` rebinds a *local* array, so the script prints
  `ALL PASSED` and exits 0 even when checks fail — the summary cannot fail today.
- **Not verified locally (needs the VPS):** a real container start with the new
  conf (Docker + a display + the image), the `ss -lntp` loopback proof on a live
  session, and a live cookie injection end to end.
- **A NOTE ON WHAT WAS TRUE WHEN THAT LINE WAS WRITTEN.** Everything above is unit
  and pure-logic verification. The container path was not merely unverified — when
  it was finally run (§5a, 2026-09-28) it did not work, for three separate reasons
  the unit tests were structurally unable to see. That is the honest lesson: a
  test that each half satisfies its own contract says nothing about the two halves
  composing, and this feature is almost entirely about composition.

---

## 5a. The real-container verification (2026-09-28) — and the three bugs it found

Docker was available after all (Docker 29.2.1 on the dev host), so the launch path
was run for real: the **real** `ghcr.io/m1k1o/neko/chromium:latest` image, the
**real** conf from `buildChromiumSupervisorConf`, the **real**
`engine-dist/swfwd-linux-amd64`, and a **real** Chrome for Testing build
(`154.0.8037.57`, downloaded from Google) in a real version cache.

It failed first, in three ways, and every one of them would have shipped silently:

1. **THE PINNED BINARY DID NOT RUN — the mount and the exec described different
   places.** The host's `<cache>/<version>` was mounted at `/opt/pinned-browser`,
   while the conf exec'd `/opt/pinned-browser/<version>/chrome-linux64/chrome`.
   supervisord reported `chromium FATAL Exited too quickly`, which reads like a
   browser crash. **Every unit test passed**, because `pinnedDockerArgs` and
   `containerPinnedBinaryPath` were each tested alone and nothing tested that they
   compose. Fixed by deriving both from one function
   (`containerPinnedVersionRoot`), and pinned by the test
   `the pin mount composes with the binary path it execs`.
2. **THE GENERATED CONF WAS INVALID SHELL.** The parity user agent contains
   parentheses, and unquoted inside `command=/bin/sh -c "…"` that is
   `Syntax error: "(" unexpected` — `/bin/sh` died before Chromium started, so the
   session was dead and the log blamed a crash. This was always latent; it only
   surfaced now because the parity flags were being **populated** for the first
   time (§4's two dead fields). Fixed with `shellArg()` (single-quoted, because
   supervisord's shlex parsing consumes double quotes before `/bin/sh` ever sees
   them), asserted by round-tripping values through a **real `/bin/sh`**.
3. **THE COOKIE CARRY COULD NOT REPORT ANYTHING TRUE.** Two defects in the CDP
   client, both silent:
   - `Cdp.call` resolved the **whole message**, so `exportCookies` read
     `result.cookies` off it, got `undefined`, and returned an empty jar **for
     every browser, always** — which is exactly why a broken carry and a broken
     readback were indistinguishable.
   - `Cdp.call` never inspected `msg.error`, so a **failed** `Storage.setCookies`
     was reported as `ok: true, count: 2`. The clone would be announced as signed
     in while holding nothing.
   The original proven script (`scripts/clone-cdp.mjs`) does neither of these — it
   throws on `res.error` and returns `res.result` — so the TypeScript port was a
   defective transcription of a working client. `injectCookies` now also **verifies
   by reading the jar back** and counts only what the browser actually holds.

### What the corrected path then proved, in the real container

| Property | Evidence |
| --- | --- |
| The pinned build runs | `supervisorctl status` → `chromium RUNNING`; `ps` → `/opt/pinned-browser/154.0.8037.57/chrome-linux64/chrome` |
| It is the version we asked for | `/json/version` → `"Browser": "Chrome/154.0.8037.57"` |
| Identity parity works | `/json/version` → `"User-Agent": "…(Windows NT 10.0; Win64; x64)…"` on a Linux container |
| The pin cannot be tampered with | `touch` and `rm` inside the container → `Read-only file system`; binary still present, mode `-rwxr-xr-x neko neko` |
| The CDP endpoint is host-loopback only | reachable at `127.0.0.1:33999`, published from the container's `swfwd` |
| State really lands in the mounted profile | real SQLite `History`, `Sessions/Session_1` readable, `Preferences` rewritten to `exit_type: Crashed` / `exited_cleanly: false` |
| **The clone opens signed in** | `INJECT {ok:true,count:2}` → `READBACK_COUNT 4`, names include both injected cookies **and** the browser's own (`SEARCH_SAMESITE`, `__Secure-ENID`), `READBACK_VALUE_MATCH true` |

The last row is the whole feature: the jar held both cookies **with the right
value**, and the presence of the browser's own cookies proves the readback is a
real reading rather than an echo of the input.

### Gate after the fixes (run the way `deploy.yml` runs it)

- `npm run test:clone` — **95/95 pass** (sync plan, pin, state restore, the CDP
  suite, and the state-pipe ingest suite).
- `npm run test:browser` — **PASSED**: relay suite (real egress, none skipped),
  conf **18/18**, pinned cache **10/10**.
- `npm run check:clone-contract` — **14 = 14**, both sides agree.
- `npm run check:workflows` — 20 `run:` blocks valid.
- `npx tsc --noEmit` — clean.
- `gofmt` clean, `go vet` clean, `go build ./...` exit 0,
  `go test ./...` exit 0, `go test -race ./pkg/wake/` exit 0.

---

## 6. Remaining work, in order

**What is DONE and proven:** the version decision and its delivery (resolve →
download → cache → read-only mount → exec the pinned binary), the cookie carry end
to end in a real container, the state materialisation (paths re-validated,
ownership and modes right, tabs nudged so they actually reopen), the refusal and
fallback codes recorded on the job, silently-triggered capture, **and the state
pipe itself (below)**.

### 6.1 The device→host state pipe — BUILT (this change)

The gap was that cookies had a route and the state half had none: history,
bookmarks, tabs and extensions could be collected on the work PC and had nowhere
to go. That is now closed, end to end:

| Piece | Where | What it does |
| --- | --- | --- |
| **Server ingest** | `lib/clone-state-ingest.ts` | Validates a manifest against the SAME rules the device uses, resolves the sync decision and checks it, stages inbound bytes, applies a delta's removals, and fingerprints back what the cache actually holds. Pure + filesystem, no DB — so it is testable. |
| **Device route** | `app/api/devices/clone-state/route.ts` | `POST …?stage=plan\|file\|finalize`, device-token auth identical to `clone-capture`. One file per request as a raw octet-stream with the path in a URL-encoded header. |
| **Device sender** | `engine/pkg/wake/state.go` | Walks the profile, filters, selects the delta, POSTs the bytes. **No subprocess, no console, no prompt** — file IO and HTTPS only. |
| **Wiring** | `engine/pkg/wake/runner.go` | `Runner.Run` does the session half then the state half, so state is carried on EVERY route — including the refusals that return early. `StateSync == nil` means nothing is touched, which keeps every existing caller byte-identical. |
| **Persistent cache** | `lib/browser-profiles.ts` + the ingest module | State survives between clones in a cache keyed by **device + browser + profile**, and each session's profile is materialised WHOLE from it. A per-session staging dir would materialise only the delta — history and bookmarks gone, the exact failure this feature exists to remove. |

**Two design decisions worth stating, because both are load-bearing:**

1. **The destructive half runs LAST.** A delta's removals are computed at the plan
   stage, returned to the device, and only applied at `finalize` — after the
   replacement bytes have landed. A device that dies mid-transfer then leaves a
   *stale* file (visible) rather than a *missing* one (silent loss).
2. **The recorded baseline is what the cache HOLDS, not what the device SENT.** A
   file that failed to stage is therefore never recorded as transferred, which
   would have made the next clone skip it and lose it for good.

**What is still unproven here:** no real device has pushed a real profile through
it, and the two ends have never been run against each other outside a test. Every
mechanism is unit- and integration-tested on both sides (95 TS + 62 Go in
`pkg/wake`, including a real `httptest` server asserting the wire format), but the
end-to-end run is item 3 below.

**What is left — deploy and one live run.**

1. **Deploy prerequisites:** `engine-dist/swfwd-linux-amd64` + `SWFWD_BIN`, a
   writable `BROWSER_PIN_CACHE_DIR` (default `/var/lib/spaceworker/browsers`; the
   host-side existence check fails closed, by name, if the binary is not there),
   `BROWSER_PROFILE_BASE_DIR` set (the state cache lives under it), and the two
   migrations in this change applied to the real database.
2. **The work PC's directories must be AV-excluded — enforced, not assumed.** The
   hard rule is that a component may only run from, or stage into, a folder
   endpoint protection has been told to leave alone. `preflight` now takes
   **several** directories (`--dir` repeatable, plus `--also-dir`) and registers
   AND VERIFIES every one of them plus the whole process family; `install-hosted.ps1`
   passes the install dir and the staging root. A partial quarantine that reported
   OK would be worse than an outright failure, so a missing verification aborts the
   install.
3. **A disposable-login live run** on the VPS: capture → `202` → the clone opens
   already signed in, WITH the profile's tabs and history materialised, and the
   egress IP is the device's. Every mechanism is now proven in isolation and in a
   real container; this is the one run that exercises them through the real
   deployment.
4. Console copy: report **state** and **session** separately, and say plainly that
   "Carry my current session" needs the one-click setup — the extension is
   force-installed under `ExtensionInstallForcelist`, which is exactly what makes
   Chrome show *"Managed by your organization"*. `stateSyncMode` /
   `stateSyncReason` on the job are the fields to render (`first_clone` vs
   `sync_on_reconnect`), and `RunResult.State` is the per-capture half.
5. Firefox destination support (only if the fleet actually needs it). Today a
   Firefox source refuses by name and offers a fresh session, which is correct
   rather than a silent Chromium substitution.




---

## 7. The trigger — completely silent, no popup, no human, ever

**The hard design condition:** a clone must start with **no popup, no click, no
human interaction of any kind**, and the source browser may be **closed at the
time**. That last part is the one that matters most: the feature exists for a
traveller whose work PC is elsewhere, so "open Chrome and click the extension"
is precisely the case that cannot happen.

### What was wrong

The popup was the only entry point. If the browser was closed, or the user was
away, nothing captured anything — so the clone opened with no session and the
feature failed exactly when it was needed. The extension also had no way to be
woken by the device agent.

### What the wake path does

`pkg/wake` (Go, device side) plus `extension/background.js`:

1. **The agent wakes the browser by itself.** `pkg/wake` launches a browser
   process against a **separate, dedicated profile directory** — never the user's
   live profile. That is what makes it safe to do silently: the user's own
   browser and profile are never touched, never locked, never disturbed, whether
   they are open or closed at the time.
2. **The extension triggers itself.** No popup: the service worker acts on its
   own wake, learning what is wanted through the native host and a mailbox file.
3. **It is genuinely invisible.** The wake profile launches without a visible
   window, so nothing appears on the work PC's screen — a popup on a shared or
   presented screen is a security event in itself.
4. **The mailbox is the handoff.** `mailbox.go` + `request.go`/`result.go` carry
   the request in and the result out as files with a TTL, so a wake that finds
   nothing to do exits cleanly instead of waiting for a human.
5. **Every failure is named.** `runner.go` returns a reason for every outcome, and
   `wake_args_test.go` / `runner_wake_test.go` / `runner_routes_test.go` pin the
   argument construction, the wake flow and the route handling.

### Why it is provably silent

`tests/Test-SilentTrigger.ps1` + `tests/silent-trigger.driver.cjs` is a proof
harness: **35 checks, `RESULT: PASSED`**. It asserts the conditions that *make*
silence true (its own profile dir, no UI on the path, a closed browser still
woken, named reasons on failure) rather than asserting the absence of a symptom.

### The boundary I will not cross

I did **not** make the extension read the user's live profile from disk, and I did
not start a second browser against that profile. Both would appear to work on an
idle machine and both are wrong: the first cannot decrypt cookies on 127+ anyway
(§1.2, F10/F11), and the second fights the user's own browser for the profile
lock — which is exactly how a clone feature corrupts a customer's real session.

The wake profile is separate by design.

---

## 8. First-time clone vs sync on reconnect

Two flows, and the difference is entirely about **how much has to move**.

### First-time clone — send everything

No usable baseline exists, so every state file is transferred and every cookie is
captured. Mode `full`, reason `first_clone`.

### Sync on reconnect — send only what changed

Every later connect is a **delta**: only added, changed and removed files move.
Mode `delta`, reason `sync_on_reconnect`. This is what makes the second and third
connect fast instead of re-uploading a profile.

**Cookies are ALWAYS sent in full, in both modes.** They are read in-process by
the extension (milliseconds) and are the entire point of the session carry, so
diffing them buys nothing — and it would require keeping old values somewhere,
which the contract forbids (TASK_119A A5). The decision carries
`cookiesAlwaysFull: true` explicitly, so no caller or log has to infer it.

### The rule that protects the replica

A delta is **only** used when the stored manifest is genuinely usable for *this*
device, browser and profile. Anything else is a full transfer with a named
reason — `browser_changed`, `profile_changed`, `device_changed`,
`browser_version_changed`, `manifest_stale`. A delta computed against the wrong
baseline omits files, and a replica that silently omits files is worse than one
that re-sends them.

The staleness window is **7 days** (`DefaultManifestMaxAge`): a week of drift can
rewrite the browsing-history database *in place*, and a delta against a stale
fingerprint list would miss exactly that. Past the window, everything is re-sent.

### Two things the tests caught that would have shipped broken

Both were found because the tests were written adversarially rather than to
confirm the code:

1. **The comparison order made the hash useless.** The size+mtime check ran
   *before* the hash check, so the documented "hash wins" rule never applied. In
   the field that means every file Chrome touches at launch gets re-uploaded —
   the exact "re-upload the whole profile on reconnect" failure the delta exists
   to prevent. Fixed: the hash is authoritative whenever both sides have one.
2. **A removal-only delta was treated as "nothing to do".** A replica has to
   *delete* what the source deleted, or it drifts. `Empty()` now accounts for
   removals, and a test pins it.

### What cannot be sent, and is refused by name

The file half must not become a second, useless and far more sensitive channel for
what the CDP route already carries. Refused, each with a reason: `Cookies`
(+journal) → `cookies_abe_bound_use_cdp`; `Login Data` (+variants, +journal) →
`passwords_abe_bound_unusable_in_clone`; `Local State` /
`app_bound_encrypted_key` → `abe_key_store_never_transferred`. `Local State` is
the key to the other two, so it is the worst of the three to move.

Path safety is enforced on **both** sides, because a manifest is a device's
*request*, not a fact: `..\..\Windows\System32` is refused by name
(`state_path_escapes_profile`, `state_path_absolute`, `state_path_unc`,
`state_path_drive_relative`), and a stored baseline containing a sensitive path
cannot resurrect it. `validateSyncDecision` cross-checks that a decision never
*requests* a path it *excluded* — the two lists must never disagree.

### Why the rule is implemented twice (Go device + TS server)

Deliberately duplicated, in `engine/pkg/wake/sync.go` + `sensitives.go` and
`lib/clone-sync-plan.ts`. The two sides sit on opposite ends of a trust boundary,
and the server must never take the device's word for what needs sending. A shared
library would mean one mistake disabling the check on both sides at once.


### Verification

- **Go:** 51 tests pass in `pkg/wake` (`-race` clean); whole engine `./...` green;
  `gofmt` and `go vet` clean. The failing-first run is part of the record: 6
  failures, 2 of them real product bugs (above), the rest test-side faults (slice
  aliasing, since `next := prev` shares a backing array; one wrong byte count; one
  wrong staleness date).
- **TypeScript:** 24 tests, **24 pass** in `lib/clone-sync-plan.test.ts`;
  `npx tsc --noEmit` clean. Wired up as `npm run test:clone`.
- **Egress — the path a clone's privacy depends on — is now proven, not skipped.**
  The 5 `REAL relay` integration tests were passing-by-skip because `RELAY_BIN`
  was unset. They now run against a freshly built `cmd/relay`: **13/13 pass,
  0 skipped**, including *relay death surfaces as 502 for the browser (no hang)*
  and *relay reconnects after the ingress restarts (survives our deploys)*.
  `scripts/test-browser-server.mjs` (now `npm run test:browser`) builds the relay
  and **fails the run if those tests skip**, so green means the egress path was
  genuinely exercised. Verified both ways: it passes with Go present, and exits 1
  with an explicit message when Go is unavailable.
- **Silence:** `Test-SilentTrigger.ps1` — **35 checks, `RESULT: PASSED`**.

---

## 9. The device-side pipe, finished (2026-09-29)

§6.1 built the pipe's two ends. This pass **closed it**: the platform now asks for the
state, the device's transport has a real caller, and both are recorded and rendered.

### What changed

| Piece | Where |
|---|---|
| The device command exists and is invoked | `cmd/hack-browser-clone/syncstate.go` + `cmd/native-host` |
| The **profile locator** — the fix that makes it work on a real work PC | `pkg/browser/source.go` |
| A **budget**, so a transfer can stop and report instead of being killed | `--budget`, `StateSyncOptions.Budget`, `Pending`/`Done` |
| The **cache as a baseline**, so a cut-short transfer continues | `fingerprintCache` (real content hashes), `loadBaseline` → `cache_baseline` |
| The platform **driver** — bounded rounds, honest naming | `lib/clone-state-sync.ts` |
| The automatic trigger | `lib/clone.ts` → `collectProfileState()` |
| The manual door | `POST /api/devices/[deviceId]/clone-state-sync` + the console's *Browser data* card |
| The record | `stateSyncPending` (+ migration), surfaced through `CloneView` |
| The vocabulary guard | `scripts/check-clone-contract.mjs` now also checks the **sync modes** |
| The README | `michael/browser-clone/STATE-PIPE.md` |

### The three findings this pass, and why each would have shipped silent

1. **The profile path was the wrong question.** `DefaultProfilePath` answers "where would
   a browser put its profile here, right now" — which under SYSTEM is the *service's* own
   empty profile. The sync would have reported `state_profile_missing` on a machine full
   of history: a failure true about the directory and a lie about the machine. Replaced by
   a **locator** that picks the most recently used profile that actually has state in it,
   and reports which one it chose (the name keys the server's cache).

2. **"The sync ran" and "the sync finished" were the same claim.** A whole profile does
   not fit in one 90-second command, and until now there was nothing to stop at, nothing
   to report, and no baseline to continue against — so a big profile would either be
   killed mid-request or restart from zero forever. Now: a device-side **budget**, a
   **finalize that always runs** (recording what landed), real **content hashes** on the
   cache so "already landed" is knowable, and `cache_baseline` as the honest name for
   "continued". `stateSyncPending` is what the console shows.

3. **The contract check could not see the vocabulary that decides behaviour.** The device
   chooses what to send from the *mode* alone — a delta means "only what you were asked
   for", anything else means "send the whole profile". A server-side spelling change would
   have made every reconnect re-send an entire profile, silently, forever. The checker now
   compares the modes **in both directions**, and its ability to fail is itself verified:
   flipping the device to `incremental` makes it exit 1 with two specific complaints.

### Verification (this pass, run the way `deploy.yml` runs it)

```
tsc               exit 0
test:clone        105/105 pass, 0 fail
test:browser      18/18 + 10/10 pass, 0 fail, none skipped (REAL relay built and run)
check:clone-contract  exit 0  — 14=14 exclusions, modes delta+full agree, 6 device reasons ⊆ 8 server
check:workflows exit 0
engine-dist       exit 0
go build/vet/test/-race   all exit 0 ;  gofmt clean
```

New tests this pass: `pkg/browser/source_test.go` (10 — the profile choice rule, including
the SYSTEM trap, the empty-profile refusal and the no-quiet-fallback rule),
`pkg/wake/state_budget_test.go` (7 — partial send at a file boundary, finalize-on-partial,
hashes declared, nothing-to-send is done-not-failed, delta sends only what was asked),
`lib/clone-state-sync-format.test.ts` (10 — the `--budget` invariant, PowerShell injection
refusals, strict `done` parsing, summary wording). 81 Go tests pass across `pkg/browser`
and `pkg/wake`.

### The migrations, applied for real (throwaway database, 2026-09-29)

The three TASK_135 migrations were **applied**, not just read, on a disposable PostgreSQL 15:

- After replaying all 69 migrations,
  `npx prisma migrate diff --from-url <that db> --to-schema-datamodel prisma/schema.prisma
  --exit-code` answers **"No difference detected" (exit 0)**. The migration set and
  `schema.prisma` agree exactly — so the three new migrations are the right shape and nothing
  they were supposed to add is missing (`stateSyncPending`, `stateSyncMode`,
  `sourceBrowserVersion`, …).
- The replay only worked after **re-ordering the history**, and that is a finding in its own
  right. `prisma migrate deploy` applies migrations in directory-name order, and **five**
  committed migrations touch an object that a *later* migration creates (the fifth is a cascade
  off the fourth):

  | Migration | Needs | Created by |
  |---|---|---|
  | `20260914150000_add_license_claim_token` | `ExeLicense` | `20260914200000_task42_store_and_licenses` |
  | `20260921000000_device_tools_v2` | `Device` | `20260922000000` |
  | `20260922120000_console_followups` | `VantraLink` | `20260923000000` |
  | `20260925000000_task119_live_session_streaming` | `CloneJob` | `20261002000000` |
  | `20261005000001_device_livecapturetoken_index_repair` | `Device_liveCaptureTokenHash_key` | `20260925000000` (the row above) |

  On an **empty** database, deploy stops at the first of these and **never reaches the TASK_135
  migrations** — a feature that would look like "the columns just aren't there" in any new
  environment, with no error that mentions TASK_135. Pre-existing (no commit in this task
  created it), but it gates this feature.

- **Correction, 2026-09-30 — measured on PostgreSQL 16 from empty, and this document previously
  got it wrong.** It said "four" and prescribed baselining alone
  (`prisma migrate resolve --applied`). Baselining alone is **not** a fix: it lets
  `migrate deploy` finish and `migrate status` report success, while leaving the database
  **missing every object those five migrations contained**, silently, because their DDL exists
  nowhere else. `migrate diff` after a baseline-only repair reported the missing
  `DeviceQueuedCommand`/`DevicePinRequest` tables, `CloneJob.sessionMode`, five
  `HostedBrowserSession` columns, `Device.liveCaptureTokenHash` + its unique index, four
  `VantraLink` columns and three `ExeLicense` columns. The working sequence — baseline the five
  **plus** apply the drift-generated DDL, asserted with `migrate diff` answering "No difference
  detected" — is in `michael/browser-clone/STATE-PIPE.md` §9, and
  `scripts/repair-migration-chain.mjs` performs it. **Never rename** an applied migration
  (`_prisma_migrations` records the name as identity).
- Still not verified: **the target database's own `_prisma_migrations` contents.** If it
  already records those four as applied, deploy skips them and runs only the new three — but
  that is a fact about the environment, and it was not readable from here.

### Honest remaining gap

**No live device has pushed a real profile through this pipe.** Both ends are tested and the
wire format is proven against a real `net/http` server, but they have never met outside a test.
Also outstanding: the three migrations applied to *the real* database (their content is
verified; the target's migration-record state is not — see above), and a Windows run of
`sync-state` (unit-tested on Linux, cross-compiles for Windows, never executed on Windows in
this task). Stated again in `michael/browser-clone/STATE-PIPE.md` §10.


## 10. Browser support: Brave made reachable, Firefox made honest (2026-09-29)

Asked "can we clone Brave / Edge / Firefox yet?", the honest answer was layer-dependent — and
that is itself the defect. `brave` was implemented in the state pipe and in the device walker
while every door into the feature refused it (the console picker, the clone-request
validation, the device clone route), so the capability was real, tested and unreachable, and
nothing reported it. Firefox, meanwhile, was **offered** by the console while no layer could
carry it.

The browser lists now come from ONE module (`lib/clone-browsers.ts`) with two sets —
**carriable** (chrome, edge, brave: the profile loads and cookies come over CDP) and
**requestable** (the above + firefox: a legitimate FRESH clone) — and the drift is enforced by
`npm run check:clone-contract`, which compares the TypeScript lists, the wire vocabulary, the
Go walker and the PowerShell validate sets, **per function**.

What changed:

- `lib/clone-browsers.ts` — the one vocabulary, imported by the console, `lib/clone.ts`, the
device clone route and the transport (re-exported from `clone-transport.ts` for compatibility).
- The console reads `CLONE_BROWSERS` for the picker, so Brave is offered; Firefox's carry
refusal is the same sentence the server would refuse with, shown **before** the click; picking
a non-carriable browser moves the form back to `fresh`.
- `lib/clone.ts` refuses `live` + non-carriable before a job row exists (`browser_not_supported`,
the same named reason the destination resolver uses), so the console reads one vocabulary.
- The device walker refuses by set membership, not `== "firefox"`, so a typo or a future
browser gets the same honest answer.
- `CdpCookies.ps1`, `ProfilePaths.ps1` and `Invoke-BrowserClone.ps1` accept `brave`
(and the generic resolvers keep `firefox`).

### Verification (this pass)

`npm run test:clone` **112/112** (0 fail, 0 skipped — `lib/clone-browsers.test.ts` added to the
suite, so it actually runs in CI) · `npm run test:browser` **PASSED** (relay 13/13 against a real
Go relay binary, session config 18/18, pinned build 10/10, nothing skipped) ·
`check:clone-contract` **exit 0** · `check:workflows` **exit 0** · `tsc` **exit 0** ·
`gofmt` clean · `go vet` / `go build` / `go test ./...` / `go test -race ./pkg/wake` all **0** ·
`engine-dist` 10 artifacts.

The contract check's own failure modes were verified by sabotage rather than asserted — see
`michael/browser-clone/STATE-PIPE.md` §12, including the case where the check flagged correct
code and the check was moved to per-function attribution. The user-facing summary of all of
this is `michael/browser-clone/BROWSER-SUPPORT.md`.

### Still not verified

Unchanged from §9: no live device has pushed a real profile through the pipe, the three
migrations are content-verified but not applied to the project's database, and `sync-state`
has not run on Windows. The Brave path inherits all three — its state half is tested, its
end-to-end path has not run.

## 11. The device half gets a guard: a Brave session bug, and the suites that never ran (2026-09-30)

§10 made Brave *reachable*. This pass found that Brave's **session** still did not travel,
and that the reason nobody knew is one of the more uncomfortable findings in this task:
the device-side suites were not running anywhere.

### 11.1 The bug — two lists in one file, already disagreeing

`lib/ProfilePaths.ps1` decided which browsers get their cookies captured in the **body** of
`Invoke-CaptureFromDir`, and which get them imported in the body of `Invoke-Restore`. Both
were written out inline, and they had already drifted apart:

```
capture:  @('chrome', 'edge')            ← Brave excluded
restore:  @('chrome', 'edge', 'brave')   ← Brave included
```

The consequence was the worst shape a failure can take here. A Brave clone:

- walked and carried its history, bookmarks, tabs and extensions — all correct;
- never attempted the cookie capture, because the gate returned false;
- left `cookie_transfer` at its initial `'none'` — the value it *also* reports for a
  browser that carries no cookies **by design**, so nothing downstream could distinguish
  "not applicable" from "silently skipped";
- returned **exit code 0**, i.e. reported a clean clone.

Every component supported Brave. The CDP module's `ValidateSet` accepted it (§10), the
`User Data` map resolved its root, the version reader read its own tree. The *composition*
did not, and no test was checking the composition.

**Why the contract check could not see it.** That check parses `[ValidateSet(...)]`
attributes, which are part of a function's *parameters*. This bug lived in a function
*body* as a bare literal, where a parameter scan cannot reach. Extending the check meant
adding a new kind of parser rather than a new case.

### 11.2 Why it survived — the device suites never ran in CI

Three PowerShell/proof suites cover this layer: `Test-Roundtrip.ps1`,
`Test-SilentTrigger.ps1` and `Test-CookieCapture.ps1`. None was in `deploy.yml` and none
was in `package.json`. All were run by hand, on Windows, by whoever remembered.

They were *unable* to run in CI, and that is the real finding: without
`SPACEWORKER_CLONE_KEY` the capture seals with **DPAPI**
(`[System.Security.Cryptography.ProtectedData]::Protect`), which throws
*"Operation is not supported on this platform"* anywhere but Windows. `Test-Roundtrip.ps1:84`
calls `Invoke-CaptureFromDir` with the key absent by default, so on CI's ubuntu runner it
dies at step 4 — after printing six PASS lines, so it *looks* like it mostly worked.

That is also why the suite had grown a quiet asymmetry: step 4c already skipped itself on
Linux (`SKIP restore.tampered-rejected (no SPACEWORKER_CLONE_KEY; DPAPI path is
Windows-only)`), while steps 4 and 4b unconditionally took the DPAPI path. Half of it knew.
### 11.3 What changed

The fix (the bug itself):

- `$script:CarriableBrowsers = @('chrome', 'edge', 'brave')` is now a script-scope
  constant in `ProfilePaths.ps1`, and **both** branches read it — the capture gate and the
  CDP import. One list cannot disagree with itself.
- The App-Bound comment was corrected: the gate applies to the whole Chromium family
  rather than being guessed per browser, so an affected Brave is refused *by name* instead
  of exporting nothing. Deliberately conservative — a named refusal or a named failure,
  never a silent `'none'`.

The guards (so it cannot come back):

1. `check:clone-contract` additionally parses, **by name**, `$script:CarriableBrowsers` and
   the **keys** of `$script:ChromiumUserDataSubdirs`, and compares both to the carriable set.
2. …and fails if a browser list appears inline at a call site again (PowerShell comments are
   stripped first, because that file's comments quote the buggy literals on purpose).
   Exactly one occurrence is expected: the constant's own definition.
3. `tests/Test-Roundtrip.ps1` §4g — **behavioural**, on a real capture: a Brave capture must
   REACH the cookie branch (`'skipped:no-local-state'` for a synthetic profile that has no
   `Local State`) and must not report `'none'`. `LOCALAPPDATA` is pointed at an empty
   sandbox for the duration, so the verdict cannot depend on whether the machine running
   the test happens to have Brave installed.
4. New `npm run test:ps` → `scripts/test-device-ps.mjs`: finds `pwsh` (its absence is a
   **failure**, not a skip), injects a random 32-byte base64 job key so the suites take the
   GCM path, runs all three suites, and fails on any `FAIL` line, a missing success marker,
   a non-zero exit, or **too few checks** — the last because one of these harnesses once
   could not fail at all.
5. `deploy.yml`: a "Device PowerShell suites" step in the build job. These suites now run
   automatically for the first time.

### 11.4 Verification — sabotage, not assertion

The bug and **both** guards were verified by re-introducing it (2026-09-30, this workspace):

| State of the code | Contract check | `Test-Roundtrip.ps1` |
|---|---|---|
| as fixed | exit 0 | exit 0 · 35 PASS · "ALL PASSED" |
| gate reverted to `@('chrome','edge')` | **exit 1** — "has 2 inline array literal(s)" | **exit 2** — `FAIL capture.brave-reaches-cookie-branch`, `FAIL capture.brave-not-no-cookies-by-design` |
| restored | exit 0 (diff vs backup: 0 lines) | — |

`npm run test:ps` **exit 0**: roundtrip 35 checks / silent-trigger 35 / cookie-capture 60,
0 failed. The runner's own guard was verified too — with a stub `pwsh` that exits 0 and
prints nothing it reports **6 problems and exits 1** ("never printed ALL PASSED" / "ran only
0 check(s)").

Full gate (the way `deploy.yml` runs it): `tsc` 0 · `test:clone` **112/112** ·
`test:browser` **PASSED** (13+18+10, none skipped) · `check:clone-contract` 0 ·
`check:workflows` 0 (21 `run:` blocks) · `engine-dist` 10 artifacts · `gofmt` clean ·
`go build`/`vet`/`test`/`-race` all 0 · `test:ps` **PASSED**.

### 11.5 Still not verified

- **No live device has pushed a real profile** — unchanged from §9/§10.
- **The end-to-end Brave path**: its state half is tested, its session half is now tested at
  the gate, and neither has run against a real Brave installation on a real machine.
- **DPAPI sealing is not exercised by CI** (Windows-only). The runner states this explicitly
  rather than implying full coverage; what CI proves is the profile logic and the GCM path.
- **Brave's real `Last Version` format and App-Bound-Encryption status** were not verified on
  a real install. The gate is therefore deliberately conservative — the same numeric rule for
  the whole Chromium family, so the worst case is a *named* refusal rather than a silent empty
  capture. If Brave turns out never to use ABE, the fix is to narrow that condition, **not** to
  widen the browser list.


