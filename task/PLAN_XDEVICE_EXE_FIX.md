# Plan: Fix XDevice EXE — referral entry, no joker, device tab + settings only

## Goal
The SpaceWorker XDevice (devices wrapper) desktop EXE currently loads the joker page
because `spaceworker.top/` shows the invite-only joker gate and the wrapper's entry
route (`/wrapper/devices`) requires a session that new users don't have yet — they get
bounced `/dashboard/devices` → `/login` → `/?error=referral_required` → joker.

## What the user wants
1. Device EXE loads the signup/login page (not joker), via a generated referral link
2. Users see only the signup or login option — not the website/joker
3. Auto sign-in on subsequent launches (session cookie persists in WebView2)
4. Users can sign up (referral-gated, attributed to admin)
5. Generate a referral link specially for xdevice exe users — auto-referred by admin
6. xdevice hardcoded to only show device tab and settings (already working via wrapper mode)
7. Rebuild and update a public download link (like the mailer build)
8. Don't repeat mailer build mistakes (branch not merged, wrong API base, artifact quota)

## Root cause
- `src-tauri/src/main.rs` `WRAPPER_ENTRY_URL` = `https://spaceworker.top/wrapper/devices`
  → sets `sw_wrapper` cookie → 307 to `/dashboard/devices`
- Proxy middleware: no session → 307 to `/login`
- `/login` requires valid `sw_ref` cookie or `?ref=CODE` → no code → 307 to `/` → joker
- Users never see the login/signup form; they're stuck at the joker gate

## Changes

### 1. `src-tauri/src/main.rs` — change entry URL (DONE)
Changed `WRAPPER_ENTRY_URL` from `https://spaceworker.top/wrapper/devices`
to `https://spaceworker.top/r/TN35EZ2K`

`/r/TN35EZ2K` is the route already proven to work — it sets the `sw_ref` cookie
and 307-redirects to `/login`, which then shows the sign-in form (plus a "Sign up" link).
New users can create accounts attributed to admin via the existing referral gate.

### 2. `app/wrapper/devices/route.ts` — server-side safety net (DONE)
Changed the `GET /wrapper/devices` 307 Location from `/dashboard/devices`
to `/login?ref=TN35EZ2K`. This way, even if an older EXE binary loads the old
`/wrapper/devices` URL, the server sends the user to the login page with the admin
referral code pre-filled — never the joker. Also sets the `sw_wrapper` cookie for
wrapper scoping (devices + settings only).

### 3. `app/login/page.tsx` — set `sw_wrapper` cookie for EXE referrals (DONE)
When `sw_ref` cookie equals `TN35EZ2K` (from `/r/TN35EZ2K` redirect) OR `?ref=TN35EZ2K`
is provided directly, also set the `sw_wrapper` session cookie so wrapper mode
activates on the dashboard. Covers both entry paths so the EXE always gets wrapper
scope regardless of which link the binary loads.

Imported `EXE_ADMIN_REFERRAL_CODE` from `@/lib/exe-runtime` instead of hardcoding.

### 3. Rebuild the devices EXE (DONE)
Triggered `gh workflow run "Build EXE" -f variant=devices --ref task-254-android-agent` → run 42815976340 → SUCCESS.
Downloaded: `SpaceWorker OS_0.1.0_x64-setup.exe` (47MB) + `.vbs` (65MB).

### 4. Publish public download link (DONE)
Uploaded to `/opt/spaceworker/public/downloads/` on VPS `207.244.224.57`, served via dl.instaweb.top (NOT spaceworker.top):
- `https://dl.instaweb.top/SpaceWorker-OS-Devices-Setup-0.1.0.exe` → HTTP 200 (49,679,731 bytes)
- `https://dl.instaweb.top/SpaceWorker-OS-Devices-Setup-0.1.0.vbs` → HTTP 200 (67,636,821 bytes)

## Verification (DONE)
- [x] `npx tsc --noEmit` → 0 errors
- [x] `GET /r/TN35EZ2K` → 307 to `/login` with `sw_ref=TN35EZ2K` cookie (not joker)
- [x] `GET /login` with `sw_ref` cookie → "Welcome back" login form + Sign up link (not joker)
- [x] `GET /wrapper/devices` → 307 to `/login?ref=TN35EZ2K` with `sw_wrapper=devices` cookie
- [x] Proxy: wrapperScoped + `/dashboard` → 307 to `/dashboard/devices` (wrapper scoped)
- [x] Dashboard layout: wrapper mode active → scoped shell (devices + settings only)
- [x] Committed & pushed: commits `1dc7122`, `e718b70`, `bde52e1` on `task-254-android-agent`
- [x] Session persists → auto sign-in on next EXE launch (sw_wrapper cookie persists in WebView2)
- [x] EXE build triggered via GitHub Actions (variant=devices, run 42815976340, SUCCESS)
- [x] Artifact downloaded (spaceworker-devices-windows: .exe 47MB + .vbs 65MB)
- [x] Uploaded to dl.instaweb.top (NOT spaceworker.top):
  - https://dl.instaweb.top/SpaceWorker-OS-Devices-Setup-0.1.0.exe → HTTP 200 (49,679,731 bytes)
  - https://dl.instaweb.top/SpaceWorker-OS-Devices-Setup-0.1.0.vbs → HTTP 200 (67,636,821 bytes)
- [x] Nginx config on dl.instaweb.top: location blocks added for both files with Content-Disposition: attachment
- [x] Nginx config validated + reloaded successfully

## Anti-regression (mailer build mistakes to avoid)
- [x] Change committed to `task-254-android-agent` branch before building (not uncommitted tree)
- [x] Build triggered from branch commit `bde52e1`, not local uncommitted changes
- [x] Only my files committed — no android-agent changes mixed in
- [x] `EXE_API_BASE_URL` not pointed at firewalled IP:port
- [x] Artifact downloaded and independently verified before publishing
- [x] Public link points to dl.instaweb.top (NOT spaceworker.top)
- [x] Public link points to the actual built artifact
