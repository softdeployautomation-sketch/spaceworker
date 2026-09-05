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
- `GET /sessions` — list registry entries `{sessionId, userId, containerName, port, status}`.
- `POST /sessions/start` `{sessionId, userId, profileDir, proxyServerValue}` — launch.
- `POST /sessions/stop` `{sessionId}` — stop + release (keeps registry history).
- `POST /sessions/kill` `{sessionId}` — stop + drop from registry (admin kill-switch).
- `POST /sessions/restart` `{sessionId?, profileDir?, proxyServerValue?}` — re-point a
  session's route (location switch).

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