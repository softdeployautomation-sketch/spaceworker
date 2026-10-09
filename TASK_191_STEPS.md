# TASK_191_STEPS — XDevice users don't see the quarantine flow

## BEFORE-PLAN (written 2026-10-10, before any code)

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

