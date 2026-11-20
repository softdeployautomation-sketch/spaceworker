# TASK_191 — Hide the quarantine/onboarding flow from XDevice (tier-3) users

## Owner's words (2026-10-09, verbatim)

> "We need to take out the quarantine automation display shown on newly added
> device away from xdevice premium, since they only have one agent which is
> public, just take out that flow showing on the ui from xdevice users, so when
> a new device comes in, its just appears without showing the run the hide or
> stay awake, it remains the same for premium plus since they can have 2 agents."

Clarified by question (2026-10-09): **UI ONLY** — the sweep stages
(hide@5min / stay-awake@10min / release@20min) KEEP RUNNING silently for
tier-3 accounts; only the DISPLAY goes away.

## Ground truth (verified in code before planning)

- `lib/vantra-link.ts` `syncDevices()` creates a `DeviceOnboarding` row for
  EVERY public-tier device — user tier is not consulted.
- The sweep (`app/api/internal/device-onboarding-sweep/route.ts`) runs hide +
  stay_on for those rows even with NO destination (a tier-3 account never has
  a private org: `isPrivateAllowed()` in `lib/vantra-link.ts` returns false for
  `reason === "xdevice"`), then releases at the 20-min plan.
- ALL display surfaces derive from ONE payload field: `devices[].onboarding`
  in `GET /api/devices` (`app/api/devices/route.ts`). Strip, row badge,
  stuck alert, failures alert (all in `components/device-list.tsx`) and the
  console's hideLabel prefill / move-error note (`components/device-console.tsx`)
  are null-gated on it.

## Design (smallest honest slice)

- **Server-side suppression at the ONE read**: when the session user is a live
  tier-3 (XDevice) account, map `onboarding: null` into the response. Payload
  SHAPE is unchanged (`onboarding` already nullable) → zero client edits,
  every display surface disappears at once, and the sync/sweep code is
  untouched (owner: UI only).
- Live tier-3 = `user.tier === XDEVICE_TIER && (premiumExpiresAt null ||
  > now)` — the exact grandfathered/null rule already used by
  `isXdeviceLive` in `lib/entitlements.ts`.
- Tier 5 (Premium Plus) and free/tier-1 behaviour: UNCHANGED (owner's spec).
- Expired tier-3 (lazily reverted to 1) counts as free → display stays,
  consistent with its entitlements.

## Slices

- **S1** — route change + tests (`tests/xdevice-onboarding-display.test.ts`,
  house require-hook on the REAL route; truth table: tier-3-live → null,
  tier-5 → kept, tier-1 → kept, tier-3-expired → kept, no session → 401).
- Gates: `npx tsc --noEmit`, eslint on touched files vs baseline,
  `npm run test:xdevice-onboarding-display` + regression on
  `test:vantra-idle-provenance`, `test:device-onboarding`, `test:device-status`.
- Commit + push per slice.

## Acceptance (owner)

New device joins an XDevice account → device row just appears; no quarantine
strip, no row badge, no stuck/failure alerts, no console hide-stage wording.
Premium Plus account → everything as today. Sweep journal shows the stages
still ran (silent automation).

## Deferred / not in scope

- Stopping the sweep stages for tier-3 (owner chose UI-only for now).
- Free-tier users still see the display (owner only named xdevice).

TASK_191_STEPS.md carries the before-plan and every dated progress entry.