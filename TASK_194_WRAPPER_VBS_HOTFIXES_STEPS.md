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

## S2 — wrapper: "Download .vbs" does nothing  ✅ DONE + COMMITTED (10450ba)

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

### After-record (2026-10-09)

Built `lib/download-text.ts` (`downloadTextFile(filename, contents, mime, extension)`):
`isTauriShell()` via `__TAURI_INTERNALS__` → lazy `@tauri-apps/plugin-dialog`
`save()` + `@tauri-apps/plugin-fs` `writeTextFile()`; a null path is treated as
"user cancelled" (NO fall-through to a second, useless download); a native fault
falls back to the browser path; the web product keeps the original Blob path.

`mintVbsFile` now calls `downloadTextFile(fileName, content, "text/vbscript", "vbs")`.

Gates: `tsc` **exit 0** · `eslint` on all three files **exit 0** · new suite
`tests/wrapper-vbs-download.test.ts` **5/5 pass, 0 fail** (helper exists +
client-safe, detects Tauri via the bridge object, uses BOTH plugins, keeps the
browser path; the UI routes the .vbs call through the helper and no longer
contains `createObjectURL`).

**DEPLOY NOTE (do not forget):** this fix is inside the wrapper EXE, so it is NOT
live from the hosted deploy — the wrapper must be rebuilt (CI `build-exe.yml`
`devices` variant, or the local `scripts/runtime-assemble.mjs` flow) and
reinstalled on the owner's machine before he can click "Download .vbs" and see a
Save-As dialog.

Trap hit & fixed while writing the gate: the first `server-only` assertion grepped
the bare word and false-failed on the comment that *explains* why the helper must
not import it — the assertion now matches the import statement only.

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

## S4 — admin invoice → wrapper user: no support-button notification  ⏳ QUEUED

Owner, 2026-10-09: "when i sent an invoice to the wrapper user, it didn't show
the notification on the support button as it should."

Leads to chase (NOT yet investigated — do not assume):
- The wrapper keeps SUPPORT by design (owner instruction, TASK_183), so the
  button itself is in scope. The unread badge is driven by the support widget's
  poll — find what `scope`/user it polls for and compare with the account the
  invoice was issued against (TASK_187 admin-issued `PremiumInvoice`).
- Wrapper entry is a HOSTED window (`/wrapper/devices` → `/dashboard/devices`),
  so the wrapper user IS a hosted session — but the scoped shell narrows nav;
  check whether the unread endpoint is one the wrapper's fetch is allowed to hit
  and whether the invoice lands in the ORG thread vs the OWNER's own thread.

## S5 — email the user on a new support message  ⏳ QUEUED (owner ask, not a bug)

Owner, 2026-10-09: "a user should get an email once they get a support message."
There is already a working email path (lib/email.ts / Resend, used by TASK_190's
admin-notify fan-out) and a support ticket model (TASK_187/188) — so this is
likely: on a user-facing reply/ticket-create, fire the same sendEmail helper.
Open Q before building: which events notify (admin reply only? ticket created
by admin? both?), and the from-address/reply-to to use.

---
(kept open for the S2/S3 after-records)
