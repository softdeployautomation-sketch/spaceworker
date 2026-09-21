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
