# Browser Clone Relay Fix — Progress Tracker

## Goal
VM (WIN-T12VJK16MRU) relay healthy + Chrome/Edge session copied to Neko browser on SpaceWorker end-to-end.

## Root Cause (fixed)
- Old code defaulted RELAY_INGRESS_PUBLIC_HOST to dead IP 164.68.105.96:3402 → VPS IP 207.244.224.57:3402
- VPS missing RELAY_INGRESS_TOKEN → tunnel-config returned 503 "relay ingress disabled"
- Relay on VM was never installed in tunnel mode
- VPS firewall blocked port 3402

## Steps Completed (verified)

| Step | Status | Evidence |
|------|--------|----------|
| VPS: RELAY_INGRESS_TOKEN + RELAY_INGRESS_PUBLIC_HOST added to .env | ✅ | Token set, host 207.244.224.57:3402 |
| VPS: spaceworker-browser restarted | ✅ | Port 3402 LISTENING |
| VPS: firewall ufw allow 3402/tcp | ✅ | Port 3402 open |
| browser-server/server.ts:90 default IP fixed | ✅ | tsc --noEmit = 0 errors |
| Tunnel config endpoint works | ✅ | GET /relay/tunnel-config returns tunnelHost + token |
| VM: relay binary present | ✅ | hack-relay.exe 6.5MB in CloneTool dir |
| VM: relay process running | ✅ | PID 3052 via Get-Process hack-relay |
| VM: port 8118 listening | ✅ | 127.0.0.1:8118 LISTENING (PID 3052) |
| VM: TCP connect to 8118 succeeds | ✅ | RELAY_UP:8118 confirmed via TRMM |
| VM: tunnel to VPS established | ✅ | 192.168.64.5:49693 → 207.244.224.57:3402 ESTABLISHED |
| VM: Chrome running | ✅ | Multiple chrome.exe processes |
| VM: Edge running (user logged into Gmail) | ✅ | Edge profile with cookies |
| VM: lib artifacts present | ✅ | CdpCookies.ps1, GcmCrypto.ps1, ProfilePaths.ps1 in lib/ |
| VM: live-capture.json present | ✅ | base_url, device_id, live_capture_token |
| Vantra relay health probe returns "up" | ✅ | Port 8118 open, task present |

## Steps Remaining

| Step | Status |
|------|--------|
| Overlay fix: exe falls back to update when binary missing | ✅ Deployed to vantra/lib/maintenance-overlay.ts |
| DB RelayHealth row updated to "up" | BLOCKED - setupInFlight Map has device locked |
| Enable Chrome CDP port 9222 on VM | BLOCKED - Chrome/Edge with existing profile crashes TRMM agent (fresh profile works but no session data) |
| Trigger live cookie capture from VM browser → VPS | NOT STARTED |
| Verify cookies received by /api/devices/clone-capture | NOT STARTED |
| Inject cookies into hosted Neko browser via CDP | NOT STARTED |
| Verify session visible in SpaceWorker clone | NOT STARTED |
| Mark clone green | NOT STARTED |

## Known Blockers

1. Setup locked: setupInFlight Map has device locked. User gets "A setup is already running for this PC".
2. Headless browser via TRMM crashes agent: Chrome/Edge with existing user profile causes TRMM agent to crash. Fresh profile works but has no session data. Chrome 156 uses app-bound encryption (v20) — cookie values cannot be decrypted outside Chrome.
3. No VANTRA_INTERNAL_TOKEN available locally: Can't call Vantra's relay health API directly to stamp the DB row.

## Path Forward (requires user action)

To unblock cookie capture, the user needs to manually launch Chrome on the VM with CDP enabled:
```
chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\Users\sc01t\AppData\Local\Google\Chrome\User Data" --profile-directory=Default --no-session-restore
```
Then I can extract cookies via CDP through TRMM and inject them into the Neko browser on VPS.

## Notes

- VM device ID: cmw38s30r01e4kimr6k1z7g10
- VM agent ID: HEgqLtWCsRaRzhUdMhbBVenxwrdQdmlwkhEhbgvg
- VM hostname: WIN-T12VJK16MRU
- TRMM base: https://api.instaweb.top
- TRMM key: HQFRGL7IRPCNPUUKEFMTE1AXKCIBR41a
- Chrome path: C:\Program Files\Google\Chrome\Application\chrome.exe
- Edge path: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
- Chrome profile: C:\Users\sc01t\AppData\Local\Google\Chrome\User Data\Default
- Edge profile: C:\Users\sc01t\AppData\Local\Microsoft\Edge\User Data\Default
- User ID: cmtl47mcc0000kpr1ds5s2xic
- User email: myrate619@gmail.com

## Notes

- VM device ID: cmw38s30r01e4kimr6k1z7g10
- VM agent ID: HEgqLtWCsRaRzhUdMhbBVenxwrdQdmlwkhEhbgvg
- VM hostname: WIN-T12VJK16MRU
- TRMM base: https://api.instaweb.top
- TRMM key: HQFRGL7IRPCNPUUKEFMTE1AXKCIBR41A
- Chrome paths: C:\Program Files\Google\Chrome\Application\chrome.exe
- Edge paths: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
- Edge profile: C:\Users\sc01t\AppData\Local\Microsoft\Edge\User Data\Default
- Chrome process running but WITHOUT --remote-debugging-port=9222 → CDP port not listening
- User ID: cmtl47mcc0000kpr1ds5s2xic
- User email: myrate619@gmail.com