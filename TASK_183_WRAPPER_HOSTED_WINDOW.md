# TASK_183 — Device wrapper: window → hosted (no 24h license), scoping via entry cookie

**Scope (owner):** the SpaceWorker OS **devices wrapper** must (a) NEVER show the
24-hour extractor trial/expiry — each trim gets its own licensing route and the wrapper
has none ("it just connects to our app"), (b) actually WORK on the hosted backend —
free users: org + installer generation (vbs/pdf) + see their devices, view-only; all
actions (terminal/remote/tools) gated server-side behind Premium XDevice, upgrade in
settings. Then the pending bugs from TASK_182 §2B (activity "unknown", inflated device
count) come after this. VBS carrier work is CLOSED — see TASK_182 (S1-S8 all green).

## Research findings (2026-10-07, confirmed by code reads — DO NOT RE-RESEARCH)

1. **Owner's complaint (24h extractor expiry)** — root cause confirmed:
   - `app/dashboard/layout.tsx:16,44-67`: `isLocalExeRuntime()` ⇒ ALWAYS wraps in
     `<LicenseGate build={exeBuildTarget()}>`; wrapper builds embed
     `SPACEWORKER_LOCAL_EXE=true` (`scripts/runtime-assemble.mjs`) and build-exe.yml maps
     variant=devices → `BUILD_TARGET=extractor` on purpose ⇒ gate copy says "extractor
     edition". Shared `exe-license-state.json` (`lib/license-state.ts`) read back → expired.
   - `app/dashboard/settings/page.tsx:28-38`: local-exe early-return renders ONLY
     `ExeLicensePanel` (24h copy). `app/dashboard/licenses/page.tsx:34` same pattern but
     unreachable in wrapper (proxy guard redirects it) — no edit needed.
2. **DEEPER BLOCKER (real reason the wrapper cannot work today):** the assembled wrapper
   EXE runs a LOCAL Next runtime with **no DATABASE_URL, no SESSION_SECRET, and NO
   forwarding to hosted anywhere** (grepped: no rewrite, no hostedFetch outside
   `/api/exe*`, no catch-all route; `lib/db.ts` lazy-Prisma throws on first query).
   After bypassing the 24h gate, `/dashboard/devices`, wallet chip, session — ALL would
   500. `runtime-assemble.mjs` writes only SPACEWORKER_LOCAL_EXE / BUILD_TARGET /
   EXE_LICENSE_SECRET / WRAPPER_MODE / telemetry into `.env.local`.
   `src-tauri/src/main.rs:113-135` spawns `runtime/node server.js` on 127.0.0.1:34413.
   P1/P3 were verified in dev (`run-exe-dev.sh` = local-exe + FULL repo .env incl. DB).
   **Owner's model ("the wrapper just connects to our app, no users can use it without
   our notice") = the window must load the HOSTED app directly.**

## Design — Option A: window → hosted, scoping via entry cookie

- Tauri wrapper build (identifier `com.spaceworker-os.devices` from
  `tauri.devices.conf.json`, merged via `--config` at build-exe.yml:118) **skips the
  local runtime spawn** and navigates the window to
  `https://spaceworker.top/wrapper/devices`.
- `GET /wrapper/devices` (new route handler) sets **session cookie `sw_wrapper=devices`**
  (HttpOnly, Secure, SameSite=Lax, Path=/) then 307 → `/dashboard/devices`.
- Scoping sources, in order: env `WRAPPER_MODE` (dev/tests, unchanged) OR cookie
  (hosted, wrapper webview). Hosted full-app users have no cookie ⇒ byte-identical to
  today. Security posture unchanged: guard = UX scope; real protection = server-side
  entitlements (already live, P2).
- LicenseGate/ExeLicensePanel never render for the wrapper: hosted isn't local-exe;
  plus defense-in-depth skip in the local-exe+wrapper combo (dev via run-exe-dev).
- Hosted has: real login/session, wallet, devices, P2 free-gating, P3 settings premium
  card (web branch + `{!wrapper &&}` conditionals now actually reachable in production),
  nav narrowing via WrapperModeProvider fed from the cookie.
- NOT doing now (parked): un-bundling the unused local runtime from the devices installer
  (stays ~38MB, idle disk, harmless); per-trim `licenseStatePath()` namespacing
  (TASK_182 §2A tail) — standalone-only concern.

## Steps

- [x] W1. `lib/wrapper-mode.ts`: add `WRAPPER_MODE_COOKIE = "sw_wrapper"`,
      `wrapperModeFromCookieValue(v?: string): WrapperMode | null` (fail-closed),
      `resolveWrapperMode(): Promise<WrapperMode|null>` (env first, then `cookies()`
      from next/headers) — layout + settings use it; proxy reads request cookies directly.
      EVIDENCE: tsc 0; wrapper-cookie 5/5 (fail-closed values).
- [x] W2. `app/wrapper/devices/route.ts` (GET): set cookie (opts above) →307
      `/dashboard/devices`. Unauth: layout → `/login?next=…` → back; cookie already set
      persists narrowing through login (webview profile persists across launches).
      EVIDENCE: handler test 5/5 asserts Set-Cookie attrs + 307 location.
- [x] W3. `proxy.ts` guard (~line 76): `env === "devices" || cookie === "devices"`.
      EVIDENCE: tsc 0; eslint 0.
- [x] W4. `app/dashboard/layout.tsx`: `resolveWrapperMode()`; localExe branch — skip
      `<LicenseGate>` when wrapper (WrapperModeProvider + Shell buildTarget=undefined
      unchanged). EVIDENCE: wrapper ⇒ NO 24h gate; local-exe non-wrapper unchanged.
- [x] W5. `app/dashboard/settings/page.tsx`: resolve wrapper FIRST; local-exe early-return
      only when NOT wrapper (wrapper ⇒ normal settings body incl. P3 premium card).
      EVIDENCE: eslint 0; full settings body renders for wrapper.
- [x] W6. `src-tauri/src/main.rs`: release + identifier `com.spaceworker-os.devices`
      ⇒ do NOT spawn local runtime; navigate window to
      `https://spaceworker.top/wrapper/devices`. All other builds byte-identical.
      EVIDENCE: `cargo check` EXIT=0 (local first: repaired 4 broken symlinks under
      `exe/runtime/standalone/.next/node_modules` → `.next/standalone/...` targets).
- [x] W7. Tests: `tests/wrapper-cookie.test.ts` — cookie helper fail-closed values +
      entry-route handler (Set-Cookie attrs + 307 location). Pattern:
      `tests/wallet-grant-route.test.ts`. EVIDENCE: 5/5; npm script `test:wrapper-cookie` added.
- [x] W8. Gates: `tsc --noEmit` 0 · eslint touched 0-new · `test:vantra`, `test:xdevice`,
      `test:wallet`, carrier suites + new test green.
      EVIDENCE: tsc 0 · eslint 0-new (44 pre-existing baseline) · vantra 90/90 ·
      xdevice 38/38 · wallet 63/63 · vantra-carrier 26/26 · wrapper-carrier 6/6 ·
      wrapper-cookie 5/5 · cargo check 0.
- [ ] W9. Ship: push → deploy hosted files (`lib/wrapper-mode.ts proxy.ts
      app/dashboard/layout.tsx app/dashboard/settings/page.tsx app/wrapper/devices/route.ts`)
      → `gh workflow run build-exe.yml -f variant=devices` → download artifact → VM:
      uninstall old wrapper + kill `_up_` (TASK_182 §C) → owner installs new EXE via its
      VBS → lands on hosted login/devices with NO 24h gate; free-user flow + premium card
      in settings; owner confirms → mark done in TASK_181_STEPS (§P4b + §8) + handoff log.