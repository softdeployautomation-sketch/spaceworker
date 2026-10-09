# TASK_191_STEPS — XDevice users don't see the quarantine flow

## BEFORE-PLAN (written 2026-10-09, before any code)

1. **S1** — `app/api/devices/route.ts`: when session user is a live tier-3
   account, map `onboarding: null` into every device of the response (shape
   unchanged; zero client edits; sync + sweep untouched — owner: UI only).
2. New test `tests/xdevice-onboarding-display.test.ts` (house require-hook,
   REAL route): tier-3-live → null · tier-5 → kept · tier-1 → kept ·
   tier-3-expired → kept · no session → 401.
3. Gates: `npx tsc --noEmit` (must stay clean) · `npx eslint` on touched files
   (no new errors) · `npm run test:xdevice-onboarding-display` · regression
   `test:vantra-idle-provenance` `test:device-onboarding` `test:device-status`.
4. Commit + push per slice via `/tmp/*-msg.txt` + `git commit -F`.
5. Progress entry after EVERY step (dated, with proof).

## PROGRESS

### 2026-10-09 12:38 — S1 DONE: route suppression + tests + all gates green

**Code (3 files + 1 new test):**
- `lib/entitlements.ts` — exported the existing pure `isXdeviceLive()` with a
  TASK_191 doc comment (no logic change; it already decided live-vs-lapsed
  tier 3 for `hasEntitlement`).
- `app/api/devices/route.ts` — after the device query, reads the session
  user's `{tier, premiumExpiresAt}` and computes
  `suppressOnboarding = isXdeviceLive(user)`; the response map now emits
  `onboarding: null` for every row when suppressed (field stays in the
  payload → shape back-compat; device-list AND device-console both poll this
  ONE route → zero client edits; sync/sweep untouched = UI-only per owner).
- `tests/vantra-idle-provenance.test.ts` — its `fakePrisma` gained
  `user.findUnique → {tier:1, premiumExpiresAt:null}` (free default keeps the
  old idle assertions honest; the route now reads the user row).
- `package.json` — `test:xdevice-onboarding-display` script added.
- NEW `tests/xdevice-onboarding-display.test.ts` — house require-hook on the
  REAL route + REAL `lib/entitlements.isXdeviceLive`: 7 cases — 401 no
  session · live tier-3 future term → null (field present) · grandfathered
  null → null · lapsed tier-3 → KEPT · tier-5 → KEPT · tier-1 → KEPT ·
  no-row device → null for everyone.

**Proofs:**
- `npm run test:xdevice-onboarding-display` → `# tests 7 # pass 7 # fail 0`
- regressions `npx tsx --test tests/vantra-idle-provenance.test.ts
  tests/device-onboarding.test.ts tests/device-status.test.ts` →
  `# tests 77 # pass 77 # fail 0`
- `npx tsc --noEmit` → `tsc exit:0`
- `npx eslint` on all 4 touched files → `eslint exit:0` (no new errors)

**Next:** commit + push S1.


### 2026-10-09 12:42 — S1 = WHOLE TASK (single-slice scope) — COMMITTED & PUSHED `65c12ca`

- Commit `65c12ca` "TASK_191 S1 — hide the quarantine display from live
  tier-3 XDevice accounts" pushed to origin/main (8 files: route,
  entitlements export, new test, fakePrisma patch, script, 3 task docs).
- Surface sweep after the commit: `grep -l onboarding components/ app/dashboard
  app/api` → only `device-list.tsx` + `device-console.tsx` consume the
  quarantine field (both poll the suppressed route) · cyberlab hits are the
  unrelated AUP wording · the only API consumer of `lib/device-onboarding` is
  the internal sweep route, deliberately untouched (owner: UI only, stages
  keep running) · the ADMIN devices tab still sees rows (not the xdevice
  user's UI; out of the owner's ask).
- **TASK_191 ACCEPTANCE:** tier-3 account → new device just appears (no
  strip/badge/stuck/failures/console stage wording); tier-5 + free unchanged
  (payload tests 4–6); sweep journal will still show the stages ran
  (silent). Live-server verification deferred to deploy verification of the
  next task (both land in one deploy).
- **TASK_191 STATUS: DONE** (code complete, gates green, pushed).

