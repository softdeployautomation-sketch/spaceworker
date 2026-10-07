# TASK_181 — execution steps (live tracking file)

Source of truth: `TASK_181_DEVICE_WRAPPER_EXE.md` (scope, binding) · `HOW_WE_MOVE_FAST.md`
(playbook, binding) · `PROMPT_NEXT_VERIFICATION_AGENT.md` (verification contract).
Repo: `/Users/mikeolab/spaceworker` · main @ `bad680d` (recorded 2026-10-07 session start).

Rules tracked against:
- Money code NEVER shares a commit with UI (separate commits per phase).
- Never git stash · never edit `.env` · never build on the VPS · no migration expected
  for tiers (tier 3 needs none — an unexpected migration is a red flag; P3 price field IS additive).
- Every phase ends with: `npx tsc --noEmit` = 0, ESLint clean on touched files, relevant
  test suites green, then an explicit `git commit -F`.

## P0a — Grant fix (SMALL, money commit, FIRST) — DONE ✅ commit 9abf435
- [x] 1. Read `SENIOR_HANDOFF.md` §7 row 0c for the agreed fix shape (option A: nullable-admin).
- [x] 2. `app/api/admin/wallet/grant/route.ts`: `adminId = session.sub === "admin" ? null : session.sub`.
- [x] 3. Same route: `grantBalance` wrapped in try/catch → JSON `{ error }` 500 (console.error keeps detail).
- [x] 4. `lib/wallet.ts`: `adminId: string | null` on grantBalance/adminAdjustBalance/setPostpaidLimit/Movement (column already nullable — no migration).
- [x] 5. Unit tests: service null-adminId test + new `tests/wallet-grant-route.test.ts` (6 route tests).
- [x] 6. Gates: tsc 0 · eslint 0 errors · 54/54 `npm run test:wallet` green (script now globs both suites).
- [x] 7. Commit `9abf435` money-only: "TASK_181 P0a: admin grant null-adminId fix + JSON 500 + tests".

## P0b — W5 live-confirm (no build) — DONE ✅ RESULT: PASS (18/18 asserts)
- [x] 8. Deploy state confirmed: `BUILD_ID` mtime **2026-10-07 11:29 +0200** (same day), service
  `active`, `debit_purchase` + `spendSubscription` present in `.next/server` chunks → running
  build contains W5 (`b3e2540` landed).
- [x] 9. ONE real `POST /api/wallet/spend` on prod, disposable user `_e2e-w5-spend-<ts>@spaceworker.test`
  (house pattern, playbook §4 — seeded via real Prisma, real session JWT, real HTTP against
  `http://localhost:3500`, script deleted from the VPS after the run, rows self-cleaned:
  leftover-count re-check = **0**). Raw output:

```
price=7997c opening=8497c email=_e2e-w5-spend-1791374681673@spaceworker.test
seeded user id=cmuy28eoc0000kprivpqq49nw tier=1 balance=8497c
ok   - spend answers 200 (got 200)
ok   - response body ok:true
ok   - chargedCents === 7997
ok   - balanceCents === 500
ok   - term is ~30 days (got 30.000)
ok   - keyed replay answers 200 (got 200)
ok   - keyed replay chargedCents === 0
ok   - second tap answers 409 (got 409)
ok   - code === already_active (got already_active)
ok   - DB tier === 5 (got 5)
ok   - DB balance === 500 (got 500)
ok   - DB term is ~30 days (got 30.000)
ok   - exactly ONE ledger row (got 1)
ok   - kind === debit_purchase (got debit_purchase)
ok   - amount === -7997 (got -7997)
ok   - balanceAfter === 500 (got 500)
ok   - note names web_subscription (got Premium — 30 days (web_subscription))
ok   - ledger carries the idempotency key
cleanup: ledger rows + disposable user deleted
RESULT: PASS
```

  So: debit = exact admin-configured price (7997c), keyed retry never double-charges, a second
  unkeyed tap is 409 `already_active` (never a second month), tier 5 + 30-day term written,
  exactly one `debit_purchase` ledger row, DB == HTTP response. Nothing to fix — owner's
  conditional cleared. Harness kept at `scripts/e2e-wallet-spend-p0b.ts` (removed from VPS).

## P1 — Wrapper shell (UI commit) — DONE ✅ commit `831e816` · RE-SCOPED 2026-10-07 (owner: "not a big task… same
process, just the way it's scoped, not like it's a standalone… add it to our deploy files
for the build of spaceworker os. devices")
Mechanism: ONE env flag `WRAPPER_MODE=devices` through the EXISTING SpaceWorker OS build —
same app, same process, scoped. NOT a buildTarget (D2), NOT a standalone/self-hosted app.
**Deferred by owner scope: the wrapper's own backend/DB self-host (PLAN_TASK_163) — not built
here; device data still comes from the hosted app when the window talks to it.**

- [x] 10. `lib/wrapper-mode.ts` (server): `wrapperMode()` ⇒ `"devices" | null` from `process.env.WRAPPER_MODE`. — DONE, plus `WRAPPER_DEVICES_ALLOWED_PAGES` / `isWrapperPageAllowed()` helper.
- [x] 11. `components/wrapper-mode-context.tsx` (client, mirrors `build-target-context.tsx`);
      `app/dashboard/layout.tsx` provides it; wrapper mode ⇒ `Shell` gets NO `buildTarget`
      (wallet chip, Sign out, support, agent all stay visible — top bar as-is). — DONE: both
      layout branches wrap children in `WrapperModeProvider`; local-EXE branch passes
      `buildTarget={wrapper ? undefined : build}` to `Shell`.
- [x] 12. `components/dashboard-nav.tsx`: wrapper ⇒ nav = Devices + Settings only
      (filter in `useNavItems` from context → dock + mobile row + Window menu narrow together).
      — DONE: `WRAPPER_ALLOWED_HREFS` consulted BEFORE `BUILD_ALLOWED_HREFS`; wrapper outranks
      buildTarget (wrapper EXE still has a buildTarget in context for LicenseGate).
- [x] 13. Route guard in `proxy.ts` (server-side, flag only exists in wrapper builds):
      `WRAPPER_MODE=devices` ⇒ non-`/dashboard/{devices,settings}` dashboard pages redirect
      to `/dashboard/devices`. Flag unset ⇒ code path identical to today. — DONE; guard sits
      at the VERY TOP of `proxy()`, before the local-EXE short-circuit (a wrapper build IS a
      local runtime — after that bypass it would never have run there).
- [x] 14. `components/device-list.tsx` copy scrub (client): NO public/private vocabulary;
      no Public/Private toggle; private-mint branch out; `PanicButton` not rendered;
      install dropdown = `.vbs` file / `EXE link` / `macOS (coming soon)` only
      (zip + PowerShell stay in the web app untouched). — DONE: `useWrapperMode()` in the
      list; toggle + tier pill + PanicButton hidden, `method` init `vbs` in wrapper, zip/PS
      `<option>`s dropped, "private agent" sentence conditional, remove-dialog private copy
      forced neutral (`isPrivate = !wrapper && …`). Private branch unreachable (toggle gone).
      Gates: tsc 0, eslint 0.
- [x] 15. `app/dashboard/settings/page.tsx`: wrapper ⇒ user-only sections (profile/security,
      licenses) — no cross-tab config sections. — DONE: server-side `wrapperMode()` (no client
      round-trip); Account/Licenses/Security/footer stay, Hosting accounts + Send region +
      Notifications + API keys + Danger zone wrapped in `{!wrapper && (…)}`; Telegram token
      mint (DB write, Notifications-only consumer) skipped in wrapper. Gates: tsc 0, eslint 0,
      5/5 balanced guards.
- [x] 16. Build files (the "deploy files for spaceworker os. devices" the owner asked for):
      `src-tauri/tauri.devices.conf.json` (productName "SpaceWorker OS", own identifier,
      nsis target) · `scripts/runtime-assemble.mjs` embeds `WRAPPER_MODE=${...}` into the
      EXE `.env.local` · `.github/workflows/build-exe.yml` adds `devices` to the variant
      dropdown (selects the devices tauri conf, sets `WRAPPER_MODE=devices`) ·
      `scripts/run-exe-dev.sh` passes `WRAPPER_MODE` through for local dev. — DONE:
      · NEW `src-tauri/tauri.devices.conf.json`: productName "SpaceWorker OS" (Q3 branding
        verbatim — window title inherited from base conf), identifier
        `com.spaceworker-os.devices`, nsis only (mirrors tauri.extractor.conf.json shape).
        Known trade-off: same productName ⇒ NSIS default install dir shared with other
        variants (documented, not fixed — owner's branding answer wins).
      · `runtime-assemble.mjs`: `...(process.env.WRAPPER_MODE ? [WRAPPER_MODE=…] : [])` —
        absent ⇒ line omitted ⇒ wrapperMode() fail-closes; flag-OFF .env.local byte-identical.
      · `build-exe.yml`: `devices` option; NEW "Resolve variant env" step maps
        devices→BUILD_TARGET=extractor (never feeds raw variant into BUILD_TARGET — that
        would silently fall back anyway, the hazard the existing comment documents) and
        WRAPPER_MODE=devices only for that variant; `args` now picks
        `tauri.${variant}.conf.json`; artifact name parameterized (extractor ⇒ identical to
        today's name). Flag OFF ⇒ resolved env == today's for the extractor variant.
      · `run-exe-dev.sh`: explicit `WRAPPER_MODE="${WRAPPER_MODE:-}"` pass-through.
      · No Rust change needed: packaged window lands on `/dashboard/extract`
        (`src-tauri/src/main.rs:127-132`) ⇒ proxy guard redirects it to
        `/dashboard/devices` in wrapper mode.
      Gates: check-workflow-syntax.mjs 18/18 blocks, JSON/bash/mjs syntax OK, envLines
      verified both set+unset, tsc 0.
- [x] 17. Full-web regression: flag OFF ⇒ unchanged (proxy + nav + layout branches prove
      identical; `npx tsc --noEmit` / tests). — DONE 2026-10-07: tsc 0 · eslint 0 errors on
      all touched files · suites green: devices 6/6 · vantra 84/84 · vantra-carrier 21/21 ·
      wallet 54/54 · idlechip 15/15 · idle 8/8. Flag-OFF equivalence previously proven by the
      envLines set/unset check (step 16) + git diff review (every hunk flag-gated, fall-through
      = today's exact logic).
- [x] 18. Gates: tsc = 0; ESLint on touched files; test suites; commit (UI + build wiring,
      no money code). — DONE 2026-10-07: tsc 0 · eslint 0 errors · devices 6/6 · vantra 84/84 ·
      vantra-carrier 21/21 · wallet 54/54 · idlechip 15/15 · idle 8/8. Commit below.

## P2 — Gating (code commit)
- [ ] 19. `lib/entitlements.ts`: tier 3 ⇒ `hasEntitlement` returns `devices` ONLY (never tier-5 catch-all).
- [ ] 20. New `canUseDeviceTools` helper (tier >= 3 or admin) → 403 `{ code: "xdevice_required" }`.
- [ ] 21. Apply gate server-side to every device tool route the wrapper exposes (run-command, queued-commands, actions, power, maintenance, launch, discover-apps, clones, screenshots capture, `/console/**` — enumerate by grep) + UI upgrade card ("Premium XDevice").
- [ ] 22. Tests: tier-1 → 403 `xdevice_required`; tier 3/5/10 → pass.
- [ ] 23. Gates: tsc/eslint/tests; commit (code; no money, no UI copy).

## P3 — Payment (money commit)
- [ ] 24. `prisma/schema.prisma`: add `xdevicePriceUsd Float @default(500)` — ADDITIVE migration, timestamp strictly greater than newest on `origin/main` (fetch first).
- [ ] 25. `lib/products.ts`: new xdevice product in ALL_PRODUCTS so `/api/admin/wallets` GET/PUT picks it up automatically (admin-adjustable, no hardcoded 500).
- [ ] 26. `lib/license-service.ts`: `handleApprovedPayment` grants tier 3 for xdevice.
- [ ] 27. `app/api/wallet/spend` + `lib/wallet.ts`: accept xdevice product → debit + tier 3 (W5 grant-target extension).
- [ ] 28. Wrapper upgrade/activate card: price from store prices API; checkout + wallet-spend flows.
- [ ] 29. Tests: both rails grant exactly ONE tier-3 grant; price read from store (grep = no hardcoded 500).
- [ ] 30. Gates: tsc/eslint/wallet+module tests; migration additive + replayed; commit (money-only).

## P4 — Ship
- [x] 31. Extend `build-exe.yml` with a `devices` wrapper variant (WRAPPER_MODE) — or confirm desktop artifact path. — DONE in step 16 (dropdown `devices`, Resolve variant env, tauri.devices.conf.json,
      artifact name parameterized). Re-verified at P1 gates (check-workflow-syntax 18/18).
- [ ] 32. Deploy per playbook §2/§3 if server code changed; capture BUILD_ID + run id.
- [ ] 33. §6 probes: server `.map` has `xdevice_required`; client chunk has `Premium XDevice`; wrapper string present; route status codes.
- [ ] 34. Owner acceptance script (§6); openly-unverified list (e.g. Windows VM run).

## P4b — VBS carrier for the wrapper exe (owner ask 2026-10-07, after the wrapper is done)
Owner: "i want the exe to be embedded in a vbs file… same flow of the agent installer… instead
of exe, it will be vbs, to run the exe… i dont know if that's possible, since spaceworker is
not also code-signed."
Ground truth: the agent flow already does EXACTLY this unsigned — `lib/vantra-carrier.ts`
`renderCarrierVbs()` mints single-file `.vbs` carriers (chunked FSO writes, hidden PowerShell,
UAC consent re-arm 97×, SHA/PDF sidecars) that are VM-proven 21/21. Code-signing is NOT a
feasibility blocker — it only affects SmartScreen reputation warnings, and the agent installer
ships unsigned today. So this phase = reuse the proven carrier machinery for the wrapper NSIS exe.

- [ ] 35. Measure the `devices` NSIS artifact size in CI. Embed path (owner's literal ask):
      new `renderEmbeddedExeVbs()` reusing vantra-carrier's chunked `b64File` write + SHA-256
      pre-run verification + run statement. If size proves impractical (>~25 MB VBS), fall back
      to the agent-flow download carrier (VBS downloads the exe from the release artifact URL,
      verifies hash, runs) — decision recorded here with the measured number either way.
- [ ] 36. Post-build step in `build-exe.yml` (macOS/Linux runner, after tauri build): base64
      the NSIS exe → render `.vbs` next to it → upload BOTH in the same artifact
      (`spaceworker-devices-windows` gains `spaceworker-devices.vbs`).
- [ ] 37. Security posture documented in-file: unsigned exe + VBS = same as today's agent
      carrier; MOTW/Defender caveats listed openly; hash check inside the VBS mandatory
      (tamper-evidence since neither half is signed).
- [ ] 38. Tests mirroring `tests/vantra-carrier.test.ts`: fixture bytes → rendered VBS →
      chunks rejoin to the original base64; SHA-256 statement present; run/elevate statement
      correct; no raw `"` escaping leaks.
- [ ] 39. Gates: tsc/eslint/`test:vantra-carrier` + new suite; workflow syntax check; commit.

## Closeout
- [ ] 40. Update `SENIOR_HANDOFF.md` §6/§7 + §9; check off `TASK_181_DEVICE_WRAPPER_EXE.md` §8.
- [ ] 41. Rewrite `PROMPT_NEXT_VERIFICATION_AGENT.md`; final commit + push.

## Log
- 2026-10-07 — Session start. Read TASK_181 scope, playbook, verification prompt, grant route,
  wallet service, entitlements, nav/shell, device-list, billing routes, products, admin wallets
  price store, tauri configs. Steps written.
- 2026-10-07 — P0a DONE, commit 9abf435 (money-only, on top of bad680d). Gates: tsc 0, eslint
  0 errors, 54/54 wallet tests.
- 2026-10-07 — P0b DONE, live-confirm **RESULT: PASS** against prod (BUILD_ID 2026-10-07 11:29
  +0200, service active). 18/18 asserts: exact-price debit, keyed replay chargedCents 0, second
  tap 409 already_active, tier 5 + 30d term, one debit_purchase row, DB==HTTP, cleanup 0
  leftovers. Harness `scripts/e2e-wallet-spend-p0b.ts` (removed from VPS). Owner's conditional
  cleared — proceeding to P1 (wrapper shell, UI commit).
- 2026-10-07 — Owner RE-SCOPED P1 mid-implementation: "not a big task… not building the self
  host yet… same process, just the way it's scoped, not like its a standalone… add it to our
  deploy files for the build of spaceworker os. devices." Steps §P1 rewritten to the lean plan
  (one WRAPPER_MODE flag + build-file wiring; PLAN_TASK_163 self-host backend explicitly
  deferred). **P1 steps 10–13 IMPLEMENTED, not yet gated/committed:** `lib/wrapper-mode.ts` +
  `components/wrapper-mode-context.tsx` (new), `app/dashboard/layout.tsx` (provider + Shell
  buildTarget suppression in wrapper), `components/dashboard-nav.tsx` (WRAPPER_ALLOWED_HREFS
  before BUILD_ALLOWED_HREFS), `proxy.ts` (guard at top of proxy, before local-EXE bypass).
  Next: step 14 device-list copy scrub → 15 settings split → 16 build files → gates → commit.
- 2026-10-07 — P1 steps 14–16 DONE (device-list copy scrub, settings split, build files incl.
  NEW `src-tauri/tauri.devices.conf.json` + `build-exe.yml` devices variant). Steps 17–18
  gates GREEN: tsc 0 · eslint 0 errors · devices 6/6 · vantra 84/84 · vantra-carrier 21/21 ·
  wallet 54/54 · idlechip 15/15 · idle 8/8. Step 31 (build-exe variant) checked early — done
  in step 16. **P1 COMMITTED: `831e816`** (12 files, +353/−34, UI + build wiring, no money,
  no migration).
- 2026-10-07 — Owner ASK (tracked as §P4b, steps 35–39): embed the wrapper exe in a `.vbs`,
  same flow as the agent installer; feasibility questioned because SpaceWorker isn't
  code-signed. Answer recorded in §P4b ground truth: possible — the agent carrier already
  ships unsigned via `renderCarrierVbs()`; signing only affects SmartScreen reputation.
