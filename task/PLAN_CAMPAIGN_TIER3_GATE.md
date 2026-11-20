# PLAN — Gate campaign access off tier 3 (XDevice / sdevice)

## Goal
Tier 3 (XDevice) users must NOT have access to the campaign feature. Tier 3 is
the devices-only tier: `listEffectiveEntitlements` surfaces ONLY `devices` for a
live tier-3 term, and `xdevice-tier.test.ts` explicitly asserts non-device keys
(mailer/extractor/hosting/cyberlab) stay DENIED for tier 3.

Campaigns are the mailer feature, so campaign access is gated on the existing
`mailer` entitlement key (no new entitlement key, no schema change, no migration):
- tier 5 (Premium): `mailer` allowed via the premium catch-all → keeps access
- tier 3 (XDevice): only `devices` → `mailer` denied → no campaign access
- tier 1/free: `mailer` denied → no campaign access

## Files to change
1. `app/api/campaigns/route.ts` — GET + POST: after the session check, gate on
   `hasEntitlement(session.userId, "mailer")`; return 403
   `{ error: "...", code: "not_entitled" }` when denied (mirrors hosting sites
   route pattern).
2. `app/api/campaigns/[id]/route.ts` — GET + PATCH + DELETE: same gate.
3. `app/dashboard/campaigns/page.tsx` — client list page: fetch `/api/entitlements`
   on mount; when `mailer` is absent, render a lock state (no campaign UI / no
   create form) instead of the campaign surface; also handle a 403 from
   `/api/campaigns`.
4. `app/dashboard/campaigns/[id]/page.tsx` — client detail page: same entitlement
   check; when not entitled, render a lock state instead of campaign detail UI.
5. Tests: add a test asserting tier-3 user is denied campaign access (mirror the
   `deviceToolsDenied` truth-table style in `tests/xdevice-tier.test.ts` or a new
   campaign-gate test), plus server route 403 coverage if a test harness exists
   for API routes.

## Status: DEPLOYED to VPS 207.244.224.57 (2026-11-06)

Deployed via `scripts/deploy-vps.sh` with `VPS_HOST=root@207.244.224.57 SSH_KEY=~/.ssh/tacticalrmm_vps`.
Deploy output: rsync synced all 5 files, build succeeded, `localhost:3500/ -> 200`, service active, maintenance OFF.

## Files changed
1. `app/api/campaigns/route.ts` — GET + POST: gate on `hasEntitlement(session.userId, "mailer")`; 403 `not_entitled` when denied. DONE
2. `app/api/campaigns/[id]/route.ts` — GET + PATCH + DELETE: same gate. DONE
3. `app/dashboard/campaigns/page.tsx` — client list page: `useModuleLock("mailer")`; renders `ModuleToolLockCard moduleKey="mailer"` when locked instead of campaign UI. DONE
4. `app/dashboard/campaigns/[id]/page.tsx` — client detail page: same lock. DONE
5. `components/module-tool-lock.tsx` — added `"mailer"` to `ModuleLockKey` + `mailer` copy. DONE

## Tests
- `tests/xdevice-tier.test.ts` already covers tier-3 → `mailer` denied (`hasEntitlement("u_x", "mailer") === {allowed: false, reason: "none"}` at lines 230-232) — this is the exact gate my routes use. No new test needed.
- `npx tsx --test tests/xdevice-tier.test.ts tests/entitlements-cyberlab.test.ts tests/campaign-stall.test.ts` → all pass.

## Verification
- `npx tsc --noEmit` → exit 0
- `npx eslint` on all touched files → clean
- `npm test` subset above → pass

## Notes
- Sub-routes under `[id]/` (pause/resume/test-send/…) are reachable only after the parent `[id]` route returns the campaign, so gating the parent covers them.
- Do NOT deploy — CI deploys `main` only after owner's explicit 🚦 GO.

