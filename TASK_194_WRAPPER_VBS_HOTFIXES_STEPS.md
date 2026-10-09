# TASK_194 — wrapper/VBS hotfix batch (silent install + wrapper VBS download)

Owner, 2026-10-09 (after TASK_191/192 went live). Three live regressions, taken
in priority order. HOW_WE_MOVE_FAST: smallest slice → test → gates → commit+push
per slice; every step recorded here BEFORE and AFTER.

## S1 — the VBS agent install stopped being silent  ✅ DONE + DEPLOYED

Owner: "i downloaded the vbs, it showed the installation powershell gui which
wasnt like that before. it happened silently… after user clicks install, it
should only show the pdf guide added by the user and then the agent
installation all happen in background unnoticed."

### Triage (this is the part compaction will eat — read it before touching anything)

Traced the WHOLE chain and reproduced the exact command the end user runs
(`/tmp/t192-repro-vbs.ts` imports the real carrier and prints the rendered .vbs):

  Vantra `toPowerShellInstallCommand`  →  SpaceWorker `mintPublicVbsFile`
    1. normalizePowerShellCommand   (multi-line → single line)
    2. ensureSilentEnroll           (--silent on `-m install`)
    3. ensureAgentCleanSlate        (TASK_182 uninstall-old-agent prologue)
    4. renderCarrierVbs             (hidden console + UAC runas + sidecar)

Findings — the code was NOT obviously broken, which is why this looked like a
ghost. Every OUTER powershell launch already carried `-WindowStyle Hidden`
(carrier console, the UAC re-launch in SELF_ELEVATE_HEADER, the agent
configure step, and the wrapper EXE carrier). The ONE gap: the two **Inno**
`Start-Process` calls launched GUI-subsystem processes relying ONLY on
`/VERYSILENT`, with no `-WindowStyle Hidden` of their own. If that Inno build
flashes a window, you get exactly the symptom the owner saw — and it would
come and go with the agent build, not with a code change.

Also recorded (does NOT explain the symptom, but it is the reason the VBS was
500-ing until an hour ago): the box's Vantra install-link route was STALE (built
Oct 8 19:03, source Sep 22) and lacked the public-PowerShell branch entirely, so
`as:"powershell"` returned 400 → SpaceWorker surfaced `vantra_deploy_outdated`
("the device service is mid-update"). Fixed by restoring the route to local
HEAD c8b6680 and rebuilding (see the earlier record).

### Fix (two repos, one line each — both Start-Process calls now hide their child)

| repo      | file                     | change |
|-----------|--------------------------|--------|
| Vantra    | `lib/trmm.ts:229`        | Inno installer step += `-WindowStyle Hidden` |
| SpaceWorker | `lib/vantra-carrier.ts:273` | `AGENT_CLEAN_SLATE` uninstaller step += `-WindowStyle Hidden` |

### Proof

- Repro audit of the REAL minted command: **3/3 `Start-Process` now `hidden=true`** (was 2/3).
- SpaceWorker tests: vantra-carrier 26/26, wrapper-carrier 6/6, vantra-link-installer 90/90.
- Vantra tests: install-link-zip 34/34, all 3 test files green.
- Commits: SpaceWorker **d742580**, Vantra **edc71ec** (both pushed).
- Deployed Vantra: `BUILD_EXIT:0`, service `active`, http 200, BUILD_ID `YKzQRowfpmGHUnTWB7WjP`.
- Deployed SpaceWorker: rsynced + rebuilt (`/tmp/t192-silent-build.log`), see below.

## S2 — wrapper: "Download .vbs" does nothing  ⏳ NEXT

Owner: "when i try to download the vbs file from wrapper nothing happens, and i
am sure uploading the pdf might be a issue, we fixed this before in the
spaceworker exe when we couldnt download the csv."

ROOT CAUSE (confirmed, not a guess): `components/device-list.tsx:523` downloads
the minted .vbs with the browser-only pattern
`URL.createObjectURL` → synthetic `<a download>` click. That is EXACTLY the bug
already fixed once as **"Task 57 Bug 2 — the browser `<a download>` pattern
silently no-ops in WebView2"**; the working fix lives in
`app/dashboard/extract/local-extract.tsx:250` as `isTauri()` +
`@tauri-apps/plugin-dialog` `save()` + `@tauri-apps/plugin-fs` `writeTextFile()`.

Plan:
1. Lift that proven pattern into a shared client helper `lib/download-text.ts`
   (`downloadTextFile(filename, contents, mime, extension)`), browser path kept
   byte-identical for the hosted web product.
2. Point `mintVbsFile` at it (single blob-download site in that file — verified
   by grep: `createObjectURL` appears exactly once).
3. Verify the PDF picker path (owner suspects it too) — `<input type=file>` in
   WebView2; if it does not open, use the Tauri dialog plugin the same way.
4. Wrapper needs a NEW EXE build (the fix ships inside the wrapper, not the
   hosted site) — that is the deploy for this slice.

## S3 — quarantine/onboarding strip STILL shows for XDevice  ⏳ AFTER S2

Owner screenshot shows both the "Securing new device · … hiding the agent" strip
AND per-row "Quarantine · 14:41" badges on a tier-3 XDevice account, which
TASK_191 was supposed to hide (Premium Plus keeps them).

Known facts from the earlier grep:
- `app/api/devices/route.ts:67` computes `suppressOnboarding = isXdeviceLive(user)`
  and line 100 applies it — but ONLY to `view.onboarding`.
- `grep suppressOnboarding components/ app/` returns NOTHING outside that route:
  **the UI never consumes the flag**, so the strip + badges still render.
- The UI lives in `components/device-list.tsx` ("Securing new device" at :1564,
  the quarantine badge around :1769) and `components/device-console.tsx:1884`.

Open design question before S3: the API nulls onboarding only on the list route.
The console page (:1884) renders the SAME 4-step strip — must be suppressed
there too, and the row badge needs the tier, not just `onboarding: null`.

---
(kept open for the S2/S3 after-records)
