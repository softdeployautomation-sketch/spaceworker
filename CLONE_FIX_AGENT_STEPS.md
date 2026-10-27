# Clone Fix — Task Agent Steps (compact insurance)

## Scope
Fix browser clone offline detection regression + CDP cookie/session carry to cloned browser + silent Chrome automation + direct egress fallback.

## Status: COMPLETE

### Phase 1: Fix Offline Detection (stepRequested) — DONE
- [x] Call refreshDeviceLiveness(userId) before deviceStatus(source) in stepRequested()
- [x] Verify stale heartbeat no longer blocks clone start

### Phase 2: Make State Sync Non-Blocking — DONE
- [x] State sync failures recorded as "state_sync_deferred" (recoverable) not permanent failure
- [x] Clone proceeds regardless of state sync outcome

### Phase 3: CDP Cookie/Session Carry (Main Feature) — DONE
- [x] Discovered existing CdpCookies.ps1 on device with Export-CdpCookies/Import-CdpCookies
- [x] Discovered existing POST /api/devices/clone-capture route with device-token auth
- [x] Discovered existing storeCapture/getCapture/injectLiveCapture in clone-live-capture.ts
- [x] Discovered existing exportCookies/injectCookies in cdp.ts
- [x] Gap identified: Nothing triggers device to export cookies via CDP and POST to clone-capture route
- [x] Job sat in "awaiting_capture" forever — no trigger mechanism existed; now fixed
- [x] CdpCookies.ps1 IS deployed to devices at C:\\ProgramData\\TacticalRMM\\CloneTool\\ (LIB_ARTIFACTS in clone-setup.ts:64)
- [x] triggerLiveCookieExport added to lib/clone.ts (lines 954-979)
- [x] Fixed buildLiveCookieExportScript function (lines 981-1015) — PowerShell script body
- [x] Restored stepRequested function declaration (was accidentally removed)
- [x] Wired triggerLiveCookieExport into stepRequested after transition to "awaiting_capture" for hosted live jobs (line 1183)
- [x] Type check compiles (zero errors)
- [x] Clone tests: 117/117 pass, 0 fail
- [x] CDP tests: 5/5 pass, 0 fail
- [x] No regressions in existing clone pipeline

### Phase 4: Direct Egress Fallback for Offline Devices — DONE
- [x] stepRequested: when egressMode === "direct" AND destination deviceKind === "hosted", skip liveness refresh and source online check entirely
- [x] sourceIsOnline recorded for routing: direct+hosted+offline source skips awaiting_capture and goes straight to "ready"
- [x] hosted+live+direct+offline: transition to "ready" with skipped reason noting no capture possible; cookie export attempted fire-and-forget (fails silently)
- [x] hosted+live+direct+online: existing awaiting_capture path (cookie export works)
- [x] hosted+live+relay: existing awaiting_capture path (unchanged)
- [x] runHostedLaunch already supports direct egress (proxyServerValue stays "", container own IP is exit)
- [x] Relay gate already skipped for direct mode (only runs when egressMode === "relay")

### Phase 5: Verification — DONE
- [x] Type check compiles (zero errors)
- [x] Clone tests: 117/117 pass, 0 fail
- [x] CDP tests: 5/5 pass, 0 fail
- [x] No regressions in existing clone pipeline
