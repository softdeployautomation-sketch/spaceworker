// Task 106 (bit C1) — client-safe idle copy. Mirrors Vantra's
// `lib/meshcentral-api.ts` `formatIdle` (the canonical unit lives there as
// `MESHCENTRAL_IDLETIME_UNIT`; `/api/devices` already hands us seconds, so
// this file only formats — never converts units, never prints raw values).

/**
 *   formatIdle(null)  → "unknown"
 *   formatIdle(20)    → "active now"
 *   formatIdle(720)   → "idle 12 min"
 *   formatIdle(10800) → "idle 3 hr"
 */
export function formatIdle(idleSeconds: number | null | undefined): string {
  if (idleSeconds === null || idleSeconds === undefined) return "unknown";
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return "unknown";
  if (idleSeconds < 60) return "active now";
  if (idleSeconds < 3600) return `idle ${Math.floor(idleSeconds / 60)} min`;
  return `idle ${Math.floor(idleSeconds / 3600)} hr`;
}
