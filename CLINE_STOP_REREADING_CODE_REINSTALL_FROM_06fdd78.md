**UPDATE 2026-09-21, after the verified-fresh reinstall still failed identically — read this part first.**

The byte-identical reinstall from run `35553462499` (`06fdd78`) is confirmed and it STILL shows the blank white "Internal Server Error" on launch. That rules out "stale build" — the install itself is now proven correct. Two things I checked that narrow this further:

1. **Admin's "Active trials" list currently shows 3 rows — none of them are this Windows VM.** They're `MacBook-Pro.local` ×2 (my own local test session against the real prod backend) and `cli-live-test` (Cline's much earlier synthetic-ping test, from before Task 58 existed — that's why its email column is `—`, it predates the email requirement entirely; not a live bug, just an old leftover row, fine to ignore or delete later). **The real Windows VM has never once reached `trial-start` or even `status` successfully** — meaning whatever's crashing is happening BEFORE that call, consistent with the screenshot showing blank white immediately with no email form ever rendering.

2. **This VM has been installed/uninstalled many times today across many different code versions** (per the whole session's EXE testing history). Uninstallers do not normally clear `%APPDATA%` — so `%APPDATA%\SpaceWorkerOS\exe-license-state.json` may still hold a leftover file from an OLDER build, in a shape today's code doesn't expect (e.g., missing fields, an old activation, whatever the last-installed-before-today version wrote). This is cheap to rule out and hasn't been checked yet:
   - On the VM: `Get-Content "$env:APPDATA\SpaceWorkerOS\exe-license-state.json"` — see what's actually in it before touching anything.
   - Then delete it (`Remove-Item "$env:APPDATA\SpaceWorkerOS\exe-license-state.json"`) and relaunch. If the crash disappears, the local state file's old shape was the cause — figure out which field NEW code chokes on (compare against the current `ExeLicenseLocalState` interface in `lib/license-state.ts`) and either migrate old shapes gracefully or document that a version bump requires clearing this file.
   - If the crash is IDENTICAL even with that file freshly deleted (truly clean slate, confirmed by re-running the `Get-Content` check first to prove it was gone), this hypothesis is dead — move straight to point 3 below.

3. **The decisive next step, if #2 doesn't fix it**: this is now almost certainly a genuine Windows/WebView2-only runtime failure that cannot be diagnosed from source reading — my own local build of the IDENTICAL source runs perfectly end-to-end against the real production backend (see "Proof current `main` is clean" below, still accurate). Get the actual browser-level evidence from the VM itself:
   - Right-click inside the SpaceWorker OS window → **Inspect** (WebView2 exposes normal Chromium devtools this way) → Console tab → read the real JS error/stack, or the Network tab to see which specific request actually returned the "Internal Server Error" body.
   - If right-click Inspect is disabled/unavailable, check **Windows Event Viewer → Windows Logs → Application** for a crash record from `SpaceWorker OS.exe` or the bundled `node.exe` around the launch timestamp — a Rust-side panic during `tauri::Builder`'s `.setup()` (e.g. a plugin failing to initialize on this Windows version) would show up there and would also explain why the request never even reaches `status`.
   - Report back the literal error text/stack. Don't guess further from source — that's what's cost the time so far.

---

# Stop re-reading source — the code is clean, the install is almost certainly stale

You've been reading `proxy.ts`, `machine-id.ts`, `license-gate.tsx`, `main.rs`, `runtime-assemble.mjs` for a while with nothing found. I just proved why: **there's nothing to find in the current code.**

## What actually happened

`gh run list` shows the build at commit `a30c092` (the one that first added Task 57/58's Tauri plugins) **failed outright**:
```
npm error Missing: @tauri-apps/plugin-dialog@2.7.3 from lock file
npm error Missing: @tauri-apps/plugin-fs@2.5.2 from lock file
npm error Missing: @tauri-apps/api@2.11.1 from lock file
```
`npm ci` failed before any build step ran — **that run produced no installer at all.** The fix (`06fdd78`, lockfile sync) landed 5 minutes later and built successfully: run `35553462499`, completed `2026-09-21T02:13:27Z`.

## Proof current `main` is clean

I built the exact current source locally (`BUILD_TARGET=extractor`/`mailer`, real `next build` + `runtime-assemble.mjs`, same bundled Node the Tauri shell uses) and ran it standalone on port 34413 exactly like `main.rs` does. `HOSTED_APP_URL` is hardcoded to the real production URL, so this hit the actual live backend, not a mock:

- Fresh machine (no local state, unused product so no server record either) → `POST /api/exe-license/status` → `{"requiresEmail":true}`, 200, no server error.
- `POST /api/exe-license/trial-start` with a real email → `{"ok":true,"startedAt":...}`, 200.
- Follow-up `status` → `inTrial:true` with the correct start time.
- Every `/_next/static/chunks/*.js` referenced by the page → 200.
- Server log: zero exceptions through the entire sequence.

Rust side is also correctly wired: `Cargo.toml` has `tauri-plugin-dialog`/`tauri-plugin-fs`, `capabilities/default.json` has `dialog:default` + `fs:allow-write-text-file`, `main.rs` registers both plugins in the builder chain. Nothing to fix there either.

## What to actually do

1. **Do not read any more source for this.** Confirm instead which artifact is actually installed on the test machine. If it's not from run `35553462499` (`06fdd78`) specifically, that's the whole bug — a stale/failed-build install, not a code defect.
2. Fully uninstall the current EXE on the test machine, `gh run download 35553462499 -R softdeployautomation-sketch/spaceworker`, install that exact artifact fresh, and retest.
3. **If — and only if — it still shows the blank white error on a confirmed-fresh install of `35553462499`**, then it's a genuine Windows/WebView2-only runtime issue that can't be diagnosed from source reading at all. Next step in that case: open the WebView2 devtools inside the running EXE (right-click → Inspect, or Tauri's dev-tools feature if enabled) and read the actual browser console error, or check Windows Event Viewer's Application log for a crash record from the process. Report back the ACTUAL error text/stack — guessing further from source won't converge faster than that one piece of real evidence.
