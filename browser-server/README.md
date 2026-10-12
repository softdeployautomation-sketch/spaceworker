# Browser subsystem (`spaceworker-browser.service`)

A SEPARATE process from the main Next.js app (`spaceworker.service`). Per plan
(PLAN.md §197) the main app stays lightweight — no browser footprint — so the
interactive Chrome/Neko runtime lives here, under its own systemd unit, and the
app talks to it over `127.0.0.1` with `BROWSER_SERVER_TOKEN`.

## Run it locally (no Docker on this Mac — real run is on the VPS)

```bash
BROWSER_SERVER_TOKEN=dev-secret npx tsx browser-server/server.ts
```

It listens on `127.0.0.1:3401`. Without `BROWSER_NEKO_IMAGE`/Docker the
`/sessions/start` path can't launch a real browser — that's fine; the app-server
integration still works (health/list, error surfaces) and the Neko launch is the
deploy-time spike.

## What it does

- Keeps the in-app `userId -> (sessionId, container)` process registry that the
  admin panel's per-session kill switch reads from and acts on.
- Launches one isolated Neko container per session (Chrome inside), mounting the
  user's Task‑6 profile directory into the container's browser user-data path, and
  pointing the browser at `--proxy-server=<resolved route>`.
- Exposes per-session host ports; the VPS front reverse-proxies
  `${APP_BASE_URL}/browser/<sessionId>/` (incl. WebSocket upgrade) to that port.

## API (all require `Authorization: Bearer $BROWSER_SERVER_TOKEN`)

- `GET /health` — liveness.
- `GET /sessions` — list registry entries `{sessionId, userId, containerName, port, status, cdpPort}`.
- `POST /api/devices/clone-state?stage=plan|file|finalize` — **device**-facing state
  ingest (see below). Not on browser-server; it lives on the app, alongside
  `clone-capture`, and uses the same device-token auth.
- `POST /pinned/ensure` `{pinnedBrowser: {fullVersion, downloadUrl}}` — installs (or finds
  in the per-version cache) an exact browser build and returns
  `{ok, fullVersion, hostRoot, containerBinaryPath, downloaded}`. **Starts nothing.**
  It exists so the caller can order things correctly — download the browser, then
  materialise the restored profile, then launch (see `lib/clone-hosted-launch.ts`).
  A build it cannot deliver is a **409** with a named `pinned_build_*` code.
- `POST /sessions/start` `{sessionId, userId, profileDir, proxyServerValue, cdp?, cloneMode?, pinnedBrowser?, restoreLastSession?, userAgent?, lang?}` — launch.
  Returns `{ok, containerName, port, containerId, nekoPassword, cdpPort, pinnedBrowserVersion, pinnedDownloaded, restoreLastSession}`.
- `POST /sessions/stop` `{sessionId}` — stop + release (keeps registry history).
- `POST /sessions/kill` `{sessionId}` — stop + drop from registry (admin kill-switch).
- `POST /sessions/restart` `{sessionId?, profileDir?, proxyServerValue?}` — re-point a
  session's route (location switch). Returns the re-allocated `cdpPort`.

### Clone sessions: `cloneMode` and `cdp` (TASK_119A A4)

Both flags are opt-in and default OFF, so the private-browser path is unchanged
(a golden test in `chromium-session-config.test.ts` asserts the generated
supervisord conf byte-for-byte).

- **`cloneMode: true`** — a hosted clone's session. Drops `--bwsi`
  ("browse without sign-in": the clone exists to carry a signed-in state) and
  adds `--password-store=basic`, because the container has no keyring and the
  profile's own store must be named explicitly or Chromium will not persist what
  CDP injects. This is TASK_117's outstanding blocker #1.
- **`cdp: true`** — the session must be reachable over the DevTools Protocol
  (how a `live` clone's captured cookies are injected). Chromium's DevTools port
  is **container-loopback only** and is *ignored entirely* when the
  user-data-dir is the profile's default (TASK_117 F5/F12), so the session
  launches on `/home/neko/.config/chromium-clone` and the container runs
  `cmd/swfwd` (mounted at `/usr/local/bin/swfwd`) as a second supervisord
  program, forwarding `0.0.0.0:9223 → 127.0.0.1:9222`. browser-server publishes
  that as **`-p 127.0.0.1:<allocated>:9223`** and returns it as `cdpPort`.

### Deploy requirement for `cdp` sessions

`swfwd` must exist on the VPS, and it must be the **linux/amd64** build:

```bash
node scripts/engine-dist.mjs          # builds engine-dist/swfwd-linux-amd64 (+ the Windows device bundle)
SWFWD_BIN=/opt/spaceworker/engine-dist/swfwd-linux-amd64   # default; override only if the layout differs
```

A missing binary fails a CDP launch with `swfwd_binary_missing: <path>` **before
the container starts** — a live clone must never come up as a browser nothing can
reach. Allocate `BROWSER_CDP_BASE_PORT` (default `33000`) outside
`BROWSER_SESSION_BASE_PORT` and `BROWSER_NEKO_EPR_BASE`, and verify after a real
live clone that `ss -lntp` shows the port on **`127.0.0.1`**, never `0.0.0.0`:
that endpoint is full control of a browser holding the user's cookies.

### Pinned browser builds: `pinnedBrowser` (TASK_135 §3)

A clone must run the **same browser build as the work PC** — Chromium refuses or
mangles a profile written by a different version, and extensions are
version-sensitive. So the caller resolves the source version
(`lib/clone-browser-pin.ts`) and asks for it here.

- On `POST /pinned/ensure` (or `start`), the build is downloaded **once per
  version** into `BROWSER_PIN_CACHE_DIR` (default `/var/lib/spaceworker/browsers`)
  and published atomically: work happens in a `.tmp-*` dir that is `rename`d into
  place only once a complete, executable browser is in it. A failed install leaves
  **no** cache entry, so the next launch can retry. Concurrent requests for one
  version share a single download.
- The version directory is bind-mounted **read-only** at
  `/opt/pinned-browser/<version>`, and Chromium is exec'd from
  `/opt/pinned-browser/<version>/chrome-linux64/chrome`. That path is validated
  (`assertPinnedBrowserPath`) because it is interpolated into the conf's
  `/bin/sh -c` command line.
- A refusal is **named and recorded**, never a silent downgrade:
  `browser_version_unknown`, `browser_version_unsupported: <major>`,
  `browser_version_index_unavailable`, `pinned_build_download_failed`,
  `pinned_build_extract_tool_missing`, `pinned_build_binary_missing`. The clone
  still runs (the cookie half does not depend on the build) but the source's
  **files are not written** into a profile a different build would open — see
  `lib/clone-hosted-launch.ts`'s `prepareCloneBrowser`.

**Verified in a real container (2026-09-28)** against
`ghcr.io/m1k1o/neko/chromium:latest` and Chrome for Testing `154.0.8037.57`:
`chromium RUNNING` on the pinned path, `/json/version` reporting
`Chrome/154.0.8037.57`, the read-only mount refusing `touch`/`rm`, and a live
cookie injection reading back with the right values.

**Two defects that only a real container could catch, both fixed and pinned:**

1. The mount destination and the exec'd binary path were produced by two
   different functions and described **different places**, so the conf exec'd a
   path that did not exist and supervisord said `chromium FATAL Exited too
   quickly`. Both now derive from `containerPinnedVersionRoot`, and a test
   composes them.
2. The parity `--user-agent` contains parentheses; unquoted inside
   `command=/bin/sh -c "…"` that is `Syntax error: "(" unexpected`, so `/bin/sh`
   died before Chromium started. Values are now shell-quoted with `shellArg`
   (single quotes, which survive supervisord's shlex parsing) and a test
   round-trips them through a real `/bin/sh`.

### Identity parity: `userAgent` / `lang` (TASK_135 §4)

Optional. When set, the clone presents the source device's platform and UI
language instead of looking like a Linux container. Absent means **no flags at
all**, which is what keeps every non-clone session's conf byte-identical.
`restoreLastSession: true` adds `--restore-last-session`; only set it once the
app has actually staged a restored `Sessions/` directory, because the flag without
files is a claim the record cannot support.

### Where the clone's STATE comes from (TASK_135 §6)

A clone's profile is built from a **persistent cache keyed by device + browser +
profile**, not from a per-job staging directory. The cache is what survives
between clones, which is what makes a reconnect a DELTA on the wire while the
materialised profile is still COMPLETE — a per-session staging dir would
materialise only the changed files, i.e. a replica with no history and no
bookmarks.

- `<BROWSER_PROFILE_BASE_DIR>/clone-state/<target-key>/` holds the state;
  `lib/clone-state-ingest.ts` owns the key (a sanitised label plus a hash of the
  raw tuple, so two targets can never share a directory).
- The device posts to `POST /api/devices/clone-state` in three stages
  (`plan` → one `file` per file → `finalize`), authenticated with the same device
  token as `clone-capture`.
- The launch materialises the WHOLE cache into the fresh per-session profile via
  `materializeCloneState`, so `BROWSER_PROFILE_BASE_DIR` must be set and writable.
- Nothing sensitive is carried: `Cookies`, `Login Data`, `Local State` and the
  lock files are refused BY NAME on both sides (the device's list and this one are
  compared by `scripts/check-clone-contract.mjs`).



## Deploy checklist (Claude / VPS side)

1. **Neko spike** — validate the spike checklist at the bottom of
   `browser-server/server.ts` on the VPS before trusting the Neko path:
   - Neko `chromium` image launches a real streamed Chrome with working mouse/keyboard.
   - `NEKO_BROWSER_ARGS` applies `--proxy-server` inside the container (banner may use a
     different env name — adapt `buildNekoArgs()` in `server.ts` if so).
   - Mounting a Task‑6 profile dir under the container's user-data path loads the cookies.
   - Two different users' sessions never share a profile dir or proxy credential.
2. Install `deploy/spaceworker-browser.service`, add its env keys to the app's `.env`
   (`BROWSER_SERVER_URL`, `BROWSER_SERVER_TOKEN`, `BROWSER_SESSION_BASE_PORT`,
   `EXIT_NODE_US`, `EXIT_NODE_UK`), enable + start it.
   - **`BROWSER_HOST_PUBLIC_IP` is required, not optional**, despite reading as
     an `if (HOST_PUBLIC_IP)` conditional in `buildNekoArgs()` — set it to the
     VPS's real public IP. Without it, Neko's WebRTC ICE candidates advertise
     the container's internal Docker IP, which is unreachable from any real
     client: the signaling WebSocket still connects fine, so the symptom is
     Neko's own "connecting" splash spinning forever with no error at all, not
     an obvious failure. Confirmed missing on the VPS and fixed 2026-09-05.
   - `BROWSER_NEKO_EPR_BASE`/`BROWSER_NEKO_EPR_WIDTH` (defaults `52000`/`20`)
     control the per-session WebRTC UDP port block — each concurrent session
     gets its own non-overlapping range, published via `-p` in the same
     `docker run` (needed alongside NAT1TO1 above — the ICE candidate being
     reachable in principle still needs the actual port opened on the host).
     Defaults comfortably cover `MAX_CONCURRENT_SESSIONS` (3); widen
     `BROWSER_NEKO_EPR_WIDTH` only if a real WebRTC negotiation failure shows
     Neko needs more ports than that per session.
3. Register `spaceworker-browser.service` in Vantra's shared
   `lib/services-control.ts`/`CONTROLLABLE_UNITS` allowlist + sudoers (Claude's
   side, same pass already done for the other units) and the reverse-proxy map
   `/browser/<sessionId>/ -> localhost:<BROWSER_SESSION_BASE_PORT + i>`.
4. Provision the free exit nodes (US/UK WireGuard/OpenVPN exit boxes exposing a
   local SOCKS5 endpoint) and set `EXIT_NODE_US` / `EXIT_NODE_UK`.

If the Neko spike fails, only `browser-server/server.ts` changes (swap the launch
strategy for Kasm or a CDP-based streamer) — the rest of the feature is agnostic.