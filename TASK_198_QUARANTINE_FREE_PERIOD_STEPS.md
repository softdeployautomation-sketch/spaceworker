# TASK_198 — Quarantine strip shows during the FREE period (wrapper)

**Status:** PLANNED — created 2026-10-10 (before any code)
**Owner report:** "the quarantine still shows during the free period before users on wrapper becomes premium, when they become [premium], it disappears."

## Evidence gathered BEFORE planning (2026-10-10)

- Suppression today (`app/api/devices/route.ts:67`): `suppressOnboarding = user !== null && isXdeviceLive(user)` — `isXdeviceLive` requires `tier === 3` AND (expiry null OR future).
- Box tiers: `[[0,7],[1,5],[3,3],[5,6]]` — free wrapper users are tier 1 (or 0), so suppression is OFF during free → strip shows; once upgraded to tier 3 it flips → "when they become, it disappears".
- Wrapper identity already exists: **`sw_wrapper` cookie** set by the `/wrapper/devices` entry route (TASK_183, `lib/wrapper-mode.ts`), plus `WRAPPER_MODE=devices` env in the EXE build. Fail-closed parsers already exported (`wrapperModeFromCookieValue` / `wrapperMode()`).

## Fix plan (slices → gates → commit each)

- **S1 — suppress for wrapper sessions regardless of tier**
  - `/api/devices` route: read wrapper scope (env first, then request cookie via `cookies()` — route handlers may await `next/headers`); `suppressOnboarding = isXdeviceLive(user) || wrapperScoped`.
  - Rationale (recorded): the wrapper sells ONE public agent (xdevice track) — the strip/stage wording is meaningless there at ANY point; web free users keep today's behaviour (they may become Premium Plus and its org flow), premium-plus/web unchanged per owner's original TASK_191 rule.
  - Tests: extend `tests/xdevice-onboarding-display.test.ts` — wrapper cookie ⇒ suppressed even when tier 1/0; no cookie ⇒ unchanged; env WRAPPER_MODE ⇒ suppressed; live tier-3 web ⇒ still suppressed (existing case).
  - Gates: tsc 0 · eslint 0 new · suite green → commit + push.
- **S2 — deploy (shared build, see TASK_197 deploy note) + live verify** via box probe: wrapper-scoped GET /api/devices shows `onboarding: null` for a free-tier account; web session unchanged.
- **S3 — closeout** with BEFORE/AFTER record.

## PROGRESS

_(entries appended after every step — dated, with proof)_
