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

## P1 — Wrapper shell (UI commit)
- [ ] 10. Find how the owner's screenshot build is produced (`build-exe.yml` + `src-tauri/tauri.conf.json`) and add `WRAPPER_MODE=devices` as a variant of THAT (NOT a `buildTarget` — server-bound shell keeps DATABASE_URL/wallet/logout).
- [ ] 11. New `lib/wrapper-mode.ts` (env read) + client flag wired through `app/dashboard/layout.tsx` → `Shell`.
- [ ] 12. `components/dashboard-nav.tsx`: wrapper mode → nav = Devices + Settings only (D1 option B). Dock + mobile row + Window menu narrow together.
- [ ] 13. Route guard: non-device/settings dashboard routes unreachable in wrapper mode (server-side, not hidden links).
- [ ] 14. `components/device-list.tsx`: copy scrub — NO public/private vocabulary; no Public/Private toggle; private mint branch out of wrapper; PanicButton not rendered; dropdown = `.vbs` / `EXE link` / `macOS (coming soon)` only (zip + PowerShell stay in web).
- [ ] 15. `app/dashboard/settings/page.tsx`: wrapper split — user-only sections, no cross-tab config.
- [ ] 16. Top bar kept as-is in wrapper: WalletChip, clock, Sign out, SupportWidget, MenuBar.
- [ ] 17. Full-web regression: flag OFF ⇒ unchanged (diff check).
- [ ] 18. Gates: tsc = 0; ESLint; tests; commit (UI-only).

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
- [ ] 31. Extend `build-exe.yml` with a `devices` wrapper variant (WRAPPER_MODE) — or confirm desktop artifact path.
- [ ] 32. Deploy per playbook §2/§3 if server code changed; capture BUILD_ID + run id.
- [ ] 33. §6 probes: server `.map` has `xdevice_required`; client chunk has `Premium XDevice`; wrapper string present; route status codes.
- [ ] 34. Owner acceptance script (§6); openly-unverified list (e.g. Windows VM run).

## Closeout
- [ ] 35. Update `SENIOR_HANDOFF.md` §6/§7 + §9; check off `TASK_181_DEVICE_WRAPPER_EXE.md` §8.
- [ ] 36. Rewrite `PROMPT_NEXT_VERIFICATION_AGENT.md`; final commit + push.

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
