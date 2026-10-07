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

## P2 — Free-tier opening + tool gating (code commit) — RE-SCOPED 2026-10-07 (owner)
Owner decisions this round (binding, verbatim anchors):
- "i dont think free users get device today on the app… we are changing the flow for the app
  NOT only the wrapper — free users should be able to create installers, vbs or whatever on
  the app."
- "we already have the organization step… its in device… i just need them able to create an
  organization and then generate the vbs with pdf installer as a free user… and gated for
  other things after for premium." → **SUPERSEDES** the earlier "ask organization name right
  after the signup code" idea — NO signup/verify change; the devices-page "Enable device link"
  button IS the organization step and it must work for free users.
- Free = create org · generate installers (all kinds on the web app; VBS-only in wrapper) ·
  see devices (read-only, no movement — devices stay public, no private account) ·
  **can't perform ANY action** (terminal, remote control, power, "any other tools at all").
- Wrapper dropdown: "i dont want the zip, just the vbs, and exe/mac will be coming soon" →
  P1 already made zip/PS web-only; now EXE also becomes a disabled "coming soon" entry in the
  wrapper. The WEB app keeps every method available to free users.
- "time all premium x subscription for one month… never show it on ui how long the premium is
  for" · card wording = **"Subscribe to Premium"** + the price the owner sets in admin
  ($500 wrapper default) — duration is NEVER in any user-facing copy (P3 wires the price).

- "premiumxdevice also gets one organisation, just that the premium unlocks the terminal
  and the other tools." → tier 3 (reason `xdevice`) NEVER gains the private companion org;
  `isPrivateAllowed` must deny reason `xdevice` (tier 5 `premium` + purchased `devices`
  grant unchanged). One org for everyone below tier 5.

- [x] 19. Entitlement core — tier 3 = devices-only AND timed (three coordinated edits):
      a. `hasEntitlement`: tier 3 ⇒ allowed ONLY for key `devices` (never the tier-5
         catch-all — a tier-3 holder must NOT light up mailer/extractor/hosting/cyberlab);
         tier 3 + expired term ⇒ denied.
      b. `listEffectiveEntitlements`: tier 3 ⇒ `keys: ["devices"]`, `premium: false` — the
         `/api/entitlements` read the console derives lock state from MUST agree with the
         server gate (it builds keys from `premium || live grants`, so tier 3 would otherwise
         show `keys: []` = locked while the server allows → upgrade card shown to a payer).
      c. Tier-3 term reuses `User.premiumExpiresAt`: extend the lazy reversion
         (`lib/premium.ts applyPremiumReversion` + the return path in `lib/session-user.ts
         getCurrentUser`) so **tier 3 + passed expiry ⇒ tier 1** on read.
         `isPremiumWithReversion`/`isPremiumTier` stay `>= 5` (tier 3 is NOT premium-wide —
         no `>= 5` gate may start passing for tier 3). NULL expiry on tier 3 = never expires
         (hand-set edge only; every grant path stamps +30d per P3). Unit tests both branches.
      — DONE 2026-10-07: `XDEVICE_TIER = 3` exported from lib/premium.ts; both
      applyPremiumReversion variants now include tier 3 in the `tier < PREMIUM_TIER` skip
      AND the `tier: { in: [...] }` updateMany filter; hasEntitlement lights `xdevice`
      reason for key `devices` only while live; listEffectiveEntitlements unions the
      `devices` key with `premium: false`. Verified by new tests (step 23 suite).
- [x] 20. `canUseDeviceTools(userId)` helper beside the gate: `(await hasEntitlement(userId,
      "devices")).allowed` → false ⇒ 403 `{ code: "xdevice_required" }`. One gate, C1-style:
      tier 5 catch-all ✓ · tier 3 ✓ · `devices` grant rows (Assistant & Devices module buyers
      MUST keep working) ✓ · free tier 1 ✗. No "or admin" clause — customer routes only carry
      a customer session (admin panel has its own cookie + routes).
      — DONE 2026-10-07: helper added in lib/entitlements.ts (one-line delegate).
      New suite `tests/xdevice-tier.test.ts` 16/16: scope creep (non-device keys denied at
      tier 3) · split-brain (list vs gate agree) · truth table · term timing (live/NULL/
      expired, downgrade PERSISTED) · grant rows intact · getCurrentUser reversion.
- [x] 21. **Open free org creation** (the enabler): `lib/vantra-link.ts ensureVantraLink` —
      drop the `hasEntitlement("assistant")` requirement so ANY signed-in user can provision
      their ONE public org (`sw-<userId>`, idempotent, still count-capped). Keep admin
      settings gates (`vantraLinksEnabled`/`vantraLinksMax`) + revoked-row handling; add a
      rate-limit bucket on `POST /api/assistant/vantra` (new abuse surface). Public mints
      (public zip/exe link, `mintPublicPsCommand`, `mintPublicVbsFile` + PDF) already have NO
      entitlement check → free VBS+PDF works the moment the org exists. Private stays fully
      gated by `isPrivateAllowed`. Update any test asserting `entitlement_required`.
      — DONE 2026-10-07: entitlement check removed (admin settings + cap kept); new
      `vantra-link` bucket 10/hr wired into the POST route (429 `rate_limited`); grep shows
      NO test/component asserting `entitlement_required` (UI just surfaces the raw code).
      tsc 0 · eslint 0 · vantra 84/84.
- [x] 22. Server-side action gating + lock UI — DONE 2026-10-07 (verified by grep across all
      device routes): 17 route files carry `deviceToolsDenied`, method-conditional exactly as
      scoped — POST/PUT-side gated, GET/read left open; `mesh-urls` GET gated (live session);
      `heartbeat`/`pin-callback`/`clone-capture` UNTOUCHED (agent/device-token facing — the
      gate doc says so explicitly); `/api/clones/*` left to `lib/clone.ts cloneEntitled`
      (assistant OR devices) + owner-scoping (free users own no clones ⇒ 404, no double-break).
      UI: `device-console` `toolsLocked` derives from `/api/entitlements` and swaps control/
      command/clone/monitoring tabs for `ToolLockCard` ("Subscribe to Premium", NO price, NO
      duration); summary+activity stay open; fullscreen `/console/[deviceId]` inherits.
      Wrapper dropdown: "EXE (coming soon)" + "macOS (coming soon)" ✓ (web unchanged).
      a. (as scoped — routes enumerated by grep, see above)
      b. (done — ToolLockCard + toolsLocked wiring)
      c. (done — device-list wrapper copy)
      a. Apply `canUseDeviceTools` (403 `xdevice_required`) to every route that REACHES THE
         DEVICE or mints a control session — re-enumerate by grep at impl time; known set:
         `run-command`, `ping`, `power` POST, `maintenance` POST, `launch`, `discover-apps`
         POST, `actions` POST, `actions/[id]` POST (approve executes), `queued-commands`
         POST/DELETE, `clones` POST, `clone-setup` POST, `clone-capture` POST,
         `screenshots/capture` POST, `screenshots` PATCH, `mesh-urls` GET (hands a live
         remote session), `panic` POST, device `DELETE` (uninstalls the agent — flag to
         owner), pin-requests if commanding (verify semantics), `/api/clones/*` where not
         already gated (`lib/clone.ts` checks `devices` — verify, don't double-break).
         READ stays open for free: list, detail, `activity`, `queued-commands` GET, `power`
         GET, `discover-apps` GET, `clones` GET, `clone-setup` GET, `screenshots` GET, frame
         GET, frame DELETE (own-data hygiene), `heartbeat`/`pin-callback` (AGENT-facing —
         never gated).
      b. `components/device-console.tsx`: control / command / clone / monitoring tabs locked
         for non-entitled → "Subscribe to Premium" upgrade card (NO price, NO duration —
         those land in P3); summary + activity stay viewable. Derive from the
         `/api/entitlements` fetch the console already makes (19b makes tier 3 agree).
         Fullscreen `/console/[deviceId]` inherits (same component).
      c. Wrapper: `components/device-list.tsx` dropdown — `EXE link` becomes disabled
         "EXE (coming soon)"; web app unchanged.
- [x] 22d. `lib/vantra-link.ts isPrivateAllowed` — deny `reason === "xdevice"`: the XDevice
      subscription unlocks tools only, ONE org (owner: "premiumxdevice also gets one
      organisation…"). `privateAllowed:false` flows through `toViewWithHistory` → UI hides
      the private install tier; `ensurePrivateLink`/private mint keep throwing
      `private_not_granted` for tier 3. Tier 5 (`premium`) + `devices` grant unchanged.
- [x] 23. Tests: free tier 1 → org create 200 + VBS(+PDF) mint 200; free tier 1 → run-command
      (+ one more action route) 403 `xdevice_required`; tier 3 → action passes, expired tier 3
      → flips to 403; tier 5 → passes; tier-1 private mint still 403 `private_not_granted`;
      `listEffectiveEntitlements` tier 3 ⇒ `["devices"]`.
      — DONE 2026-10-07, ALL GREEN:
      a. ✅ `tests/xdevice-tier.test.ts` now 21/21 — `deviceToolsDenied` truth table added
         (free 403 `{error:"xdevice_required"}` · tier-3 live null · expired 403 · tier-5 null
         · devices-grant null · unknown 403), real `lib/device-gate` + fake `next/server`.
      b. ✅ NEW `tests/xdevice-route-gate.test.ts` 5/5 — run-command + power POST through the
         REAL gate + REAL entitlements (fake db): free 403 with `runCommandNow`/
         `runPowerAction` recorders UNTOUCHED · tier-3 live runs (200) · tier-3 expired flips
         403 + downgrade PERSISTED · tier-5 runs · no session 401.
      c. ✅ `tests/vantra-link-installer.test.ts` 90/90 (84+6 new): free `ensureVantraLink`
         provisions exactly ONE org (second call = 0 fetches) · admin disable/cap still
         enforced · route `POST /api/assistant/vantra` 200 hands SESSION user to the
         provisioner · rate bucket 429 `rate_limited` · **22d**: `reason:"xdevice"` → private
         mint + companion both 403 `private_not_granted` (zero Vantra calls) while
         `reason:"grant"` still provisions + mints. VBS(+PDF) 200 for free was ALREADY covered
         (TASK_178/179 tests run under the denied-entitlement default = a free account).
      d. ✅ `package.json` `test:xdevice` = both gate suites.
      — concrete suite plan (2026-10-07):
      a. `tests/xdevice-tier.test.ts`: add `deviceToolsDenied` truth table (real
         `lib/device-gate` + fake `next/server`): free → 403 `{error:"xdevice_required"}`,
         tier-3 live → null, tier-3 expired → 403, tier-5 → null, devices grant → null.
      b. NEW `tests/xdevice-route-gate.test.ts`: run-command + power POST through the REAL
         device-gate + REAL entitlements (fake db, wallet-grant require-hook pattern):
         free → 403 `xdevice_required` AND `runCommandNow`/`runPowerAction` NEVER called;
         tier-3 live → passes gate; expired tier-3 → 403; tier-5 → passes; no session → 401.
      c. `tests/vantra-link-installer.test.ts`: `ensureVantraLink` free provisioning
         (entitlement-less user → ONE org POST `sw-<userId>`, idempotent second call makes
         ZERO new org calls; `vantraLinksDisabled`/`Max` still enforced) + private mint with
         `reason:"xdevice"` → 403 `private_not_granted` (22d) while `reason:"grant"` passes.
      d. `package.json`: `test:xdevice` script (both gate suites).
- [x] 24. Gates: tsc 0 · eslint 0 on touched files · suites green; commit (code only — no
      money, no price copy, no migration).
      — DONE 2026-10-07. Gates: tsc **0** · eslint **exit 0** · xdevice 24/24 (tier 21 +
      route-gate 5) · vantra 90/90 · wallet 54/54 · devices 6/6 · vantra-carrier 21/21 ·
      idlechip 15/15 · idle 8/8. Grep of touched components: NO price, NO duration copy.
      Migration: NONE. Money code: NONE (P2 is gating only).

## P3 — Payment (money commit) — re-scoped 2026-10-07
Owner: "$500 for the wrapper" · "in admin, time all premium x subscription for one month…
then i will decide to give them another subscription myself" · "never show it on ui how long
the premium is for" · wording = "Subscribe to Premium" + admin price.
- [x] 25. `prisma/schema.prisma`: add `xdevicePriceUsd Float @default(500)` — ADDITIVE
      migration, timestamp strictly greater than newest on `origin/main` (fetch first).
      NO new term column: the tier-3 term lives in `premiumExpiresAt` (step 19c).
      — DONE 2026-10-07. `xdevicePriceUsd @default(500)` @ schema:269; migration
      `20261117000000_task181_xdevice_price` (greater than newest on origin/main).
- [x] 26. `lib/products.ts`: new xdevice product in `ALL_PRODUCTS`
      (`priceField: "xdevicePriceUsd"`) so `/api/admin/wallets` GET/PUT and
      `/api/store/prices` pick it up automatically (admin-adjustable, no hardcoded 500).
      — DONE 2026-10-07. product kind `xdevice` @ lib/products.ts:219; surfaced via
      store prices + admin wallets routes (both iterate ALL_PRODUCTS).
- [x] 27. `lib/license-service.ts handleApprovedPayment`: xdevice ⇒ tier 3 +
      `premiumExpiresAt = now + PREMIUM_DAYS_PER_CHARGE` (30d = owner's "one month"; re-grant
      extends from current expiry, stacking like every other grant). HARD RULE: never lower
      an active tier-5 user (a wrapper purchase must not downgrade Premium).
      — DONE 2026-10-07. checkout+submit treat xdevice as session-required like web/module;
      grantXDeviceTerm path sets tier 3 + premiumExpiresAt; tier-5 never lowered (guard in
      lib/premium.ts + test).
- [x] 28. `app/api/wallet/spend` + `lib/wallet.ts`: accept `product: "xdevice"` → debit the
      admin price + tier 3 + 30d (mirror W5 contract: insufficient 402; tier-3-active OR
      tier-5-active ⇒ 409 `already_active`; keyed replay 0-charge; CAS 409 `wallet_contended`).
      — DONE 2026-10-07. server-side cents from AdminSetting.xdevicePriceUsd (never body);
      XDEVICE_TIER_FOR_SPEND = 3 (lib/wallet.ts:108); both already_active branches tested.
- [x] 29. Admin extend surface: owner can grant tier 3 (+30d) and EXTEND an active tier-3
      term ("increase their monthly subscription duration") — extend the existing admin
      users tier/grant routes; the expiry value stays server/admin-side only.
      — DONE 2026-10-07. `POST /api/admin/users/[id]/grant-premium` body `{days?, tier?}`
      with tier 3|5 validation; stacking extend semantics unchanged; tier-3 expiry never
      rendered to the user (server/admin-side only).
- [x] 30. Upgrade UI (Settings card + device-console card): price from `/api/store/prices`,
      wording **"Subscribe to Premium — $X"** (checkout + wallet-spend flows). ZERO duration
      copy anywhere (grep for "30 day/month" in touched components before commit).
      — DONE 2026-10-07. billing page + device-console render "Subscribe to Premium" /
      "Subscribe to Premium — $X" from store prices. xdevice success copy = "Premium
      activated." (no date, no term). Only duration string left in billing/page.tsx:681 is
      the PRE-EXISTING tier-5 web fallback (`product !== "xdevice"` branch) — untouched
      behavior, no test depends on it.
- [x] 31. Tests: both rails grant exactly ONE tier-3 term · price read from store (grep =
      no hardcoded 500) · tier-5 never downgraded · `already_active` on tier-3-active.
      Gates: tsc/eslint/wallet+module tests · migration additive + replayed · commit (money).
      — DONE 2026-10-07. NEW `tests/xdevice-payment.test.ts` 14/14 (hook broadened to any
      `/lib/*.ts` parent so exe-license's `server-only` import is stubbed too). Gates:
      tsc **0** · eslint **exit 0** (touched files) · xdevice 38/38 (tier 16 + route-gate 8 +
      payment 14) · wallet 63/63 (incl. grant-route 9) · vantra 90/90 · devices 6/6 ·
      module-store 11/11 · vantra-carrier 21/21 · idlechip 15/15 · idle 8/8.

## P4 — Ship — re-scoped 2026-10-07 (build ONCE, clean — owner: "check the previous spaceworker extractor exe… the steps and issues were noted… make sure we dont run into those issues again")
Build contract = `EXE_BUILD_LESSONS_LEARNED.md` (repo root — read it in full before
triggering) + `HOW_WE_MOVE_FAST.md` §5/§6. The non-negotiables from it:
  runtime-assemble scrubs `.env` + strips `.ts/.tsx` + fail-closes on placeholder secret ·
  `main.rs` calls `.run()` not `.build()` · `_up_/` candidate-path probe · full Windows Node
  dist + `node --version` guard · UI checked at packaged window size AND min size ·
  `git status` clean + pushed (`origin/main..HEAD` empty) BEFORE `gh workflow run` ·
  the REAL CI artifact downloaded/unpacked/verified (`.ts` count 0, no secret values) ·
  Windows VM install must `Remove-Item _up_` first (stale-runtime trap, §5) ·
  local `next build` failure ≠ code failure (CI build is authoritative).
- [x] 32. Extend `build-exe.yml` with a `devices` wrapper variant (WRAPPER_MODE) — DONE in step 16 (dropdown `devices`, Resolve variant env, tauri.devices.conf.json,
      artifact name parameterized). Re-verified at P1 gates (check-workflow-syntax 18/18).
- [x] 33. Deploy per playbook §2/§3 if server code changed (tar-over-ssh, `--exclude='.env'`,
      §2a full-tree parity check, CI workflow builds — never `npm run build` on the VPS);
      capture BUILD_ID + run id.
      — DONE 2026-10-07. §2 recipe: trees rsync'd wholesale (app lib components tests prisma,
      `--exclude='.env'`), root files via `scripts/deploy-vps.sh` (maintenance page + rollback
      + runtime assertions). §3: pg_dump backup `/tmp/pg_dump_task181_pre.sql` (84.6 MB) →
      `migrate deploy` applied `20261117000000_task181_xdevice_price` → §6b drift = EMPTY
      migration (0 xdevice lines). Two pre-existing box issues found & fixed en route:
      (1) stray root `probe.ts`/`dump-pubkey.ts`/`send-deferred.ts` (untracked server debris)
      broke `next build` typecheck on run 1 → moved to `/root/stray-ts-task181/` (preserved),
      rollback had served 200 throughout; (2) §2a caught `next.config.ts` stale — missing
      tesseract.js externalization from f63a335 → shipped + rebuilt. Final §2a: **0 missing,
      0 stale**. Push `bad680d..31ec7c3` → CI Build&Deploy run `37664255586` success (box
      build is authoritative, ran after). BUILD_ID `V_KHa_EoMeO3HT4HdCgMT`, service active,
      `/ → 200`, maintenance OFF.
- [x] 34. §6 probes: server `.map` has `xdevice_required`; client chunk has `Subscribe to
      Premium` (no duration string); wrapper strings present; route status codes
      (free 403 xdevice_required / tier-3 pass).
      — DONE 2026-10-07, all against the LIVE build: server chunks grep `xdevice_required` ✓;
      client chunks grep `Subscribe to Premium` ✓ and the ONLY `30 days` hit is the
      pre-existing tier-5 web fallback (`product !== "xdevice"` branch) — xdevice client copy
      carries no term ✓. Live route codes via §4 harness `scripts/e2e-xdevice-gate-p4.ts`
      (disposable users, self-cleaning) → **RESULT: PASS 8/8**: no-session 401 · free 403
      `{error:"xdevice_required"}` · live tier-3 PASSES gate (reaches device layer → 404 on
      fake id) · expired tier-3 403 xdevice_required. Harness deleted from VPS after run
      (kept in repo for reproducibility).
- [ ] 35. Owner acceptance script (§6) + lessons checklist above on the REAL artifact;
      openly-unverified list (e.g. Windows VM run).

## P4b — VBS carrier for the wrapper exe (owner ask 2026-10-07, after the wrapper is done)
Owner: "i want the exe to be embedded in a vbs file… same flow of the agent installer… instead
of exe, it will be vbs, to run the exe… i dont know if that's possible, since spaceworker is
not also code-signed."
Ground truth: the agent flow already does EXACTLY this unsigned — `lib/vantra-carrier.ts`
`renderCarrierVbs()` mints single-file `.vbs` carriers (chunked FSO writes, hidden PowerShell,
UAC consent re-arm 97×, SHA/PDF sidecars) that are VM-proven 21/21. Code-signing is NOT a
feasibility blocker — it only affects SmartScreen reputation warnings, and the agent installer
ships unsigned today. So this phase = reuse the proven carrier machinery for the wrapper NSIS exe.

- [ ] 36. Measure the `devices` NSIS artifact size in CI. Embed path (owner's literal ask):
      new `renderEmbeddedExeVbs()` reusing vantra-carrier's chunked `b64File` write + SHA-256
      pre-run verification + run statement. If size proves impractical (>~25 MB VBS), fall back
      to the agent-flow download carrier (VBS downloads the exe from the release artifact URL,
      verifies hash, runs) — decision recorded here with the measured number either way.
- [ ] 37. Post-build step in `build-exe.yml` (macOS/Linux runner, after tauri build): base64
      the NSIS exe → render `.vbs` next to it → upload BOTH in the same artifact
      (`spaceworker-devices-windows` gains `spaceworker-devices.vbs`).
- [ ] 38. Security posture documented in-file: unsigned exe + VBS = same as today's agent
      carrier; MOTW/Defender caveats listed openly; hash check inside the VBS mandatory
      (tamper-evidence since neither half is signed).
- [ ] 39. Tests mirroring `tests/vantra-carrier.test.ts`: fixture bytes → rendered VBS →
      chunks rejoin to the original base64; SHA-256 statement present; run/elevate statement
      correct; no raw `"` escaping leaks.
- [ ] 40. Gates: tsc/eslint/`test:vantra-carrier` + new suite; workflow syntax check; commit.

## Closeout
- [ ] 41. Update `SENIOR_HANDOFF.md` §6/§7 + §9; check off `TASK_181_DEVICE_WRAPPER_EXE.md` §8.
- [ ] 42. Rewrite `PROMPT_NEXT_VERIFICATION_AGENT.md`; final commit + push.

## Log
- 2026-10-07 — Session start. Read TASK_181 scope, playbook, verification prompt, grant route,
  wallet service, entitlements, nav/shell, device-list, billing routes, products, admin wallets
  price store, tauri configs. Steps written.
- 2026-10-07 — P2 steps 19+20 DONE: tier-3 entitlement core + canUseDeviceTools + new suite
  `tests/xdevice-tier.test.ts` 16/16. Gates: tsc 0 · eslint 0 · wallet 54/54 · devices 6/6 ·
  vantra 84/84 · vantra-carrier 21/21 · idlechip 15/15. Two test-harness bugs fixed en route:
  (a) an insert landed inside `seedGrant` (missing `return g; }`) orphaning the tests into
  helper-scoped subtests — restored helper close + single beforeEach; (b) hardcoded
  `2026-10-07T12:00:01Z` "future" went stale vs the real 14:26 clock making every live-term
  case fail — `past`/`future` now relative to `Date.now()` (documented in-file).
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
- 2026-10-07 — Owner RE-SCOPED P2+P3+P4 (verbatim decisions in §P2/§P3/§P4 headers):
  (1) free users on the WEB app can create the org + mint installers (VBS+PDF included) —
  no signup step added, the devices "Enable device link" IS the org step; (2) free = see-only,
  zero device actions → `xdevice_required`403; (3) wrapper dropdown = VBS only, exe/mac
  "coming soon"; (4) tier 3 = devices-only AND timed via `premiumExpiresAt` (30d grants,
  admin-extendable), `listEffectiveEntitlements` must agree; (5) NO duration ever in UI,
  wording "Subscribe to Premium" + admin price ($500 default); (6) P4 build must follow
  `EXE_BUILD_LESSONS_LEARNED.md` — build once, clean. Step numbers: P2 19–24, P3 25–31,
  P4 32–35, P4b 36–40, Closeout 41–42.
- 2026-10-07 — **P2 COMPLETE (steps 19–24)**: free-tier org open (step 21), 17 device routes
  gated + console lock UI + wrapper EXE "coming soon" (step 22), `isPrivateAllowed` denies
  reason `xdevice` — "premiumxdevice also gets one organisation… premium unlocks the terminal
  and the other tools" (step 22d), tests (step 23: xdevice-tier 21, NEW route-gate suite 5,
  vantra 90 incl. 6 new free-org/one-org tests, `test:xdevice` script), gates all green
  (tsc 0 · eslint 0 · wallet 54 · devices 6 · carrier 21 · idlechip 15 · idle 8).
  **NEXT: P3 step 25 (payment: additive `xdevicePriceUsd` + money commit).**
