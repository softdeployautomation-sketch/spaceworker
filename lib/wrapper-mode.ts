import "server-only";

// TASK_181 D2 — wrapper mode, deliberately ORTHOGONAL to lib/exe-build-target.ts.
//
// buildTarget implies the LOCAL runtime path: no DATABASE_URL, hidden wallet chip
// and Sign out, license-gated shell (components/shell.tsx:52,56,77). The device
// wrapper is the opposite — server-bound (wallet, sessions, support, device fleet
// all ride the hosted backend), so it gets its OWN flag here: WRAPPER_MODE=devices.
//
// Same app, same process, same build pipeline — one env var narrows nav, routes
// and copy (owner, 2026-10-07: "same process, just the way it's scoped, not like
// its a standalone"). It is ONLY ever set by the wrapper build wiring
// (scripts/runtime-assemble.mjs embedding WRAPPER_MODE into the EXE's
// .env.local, and .github/workflows/build-exe.yml's `devices` variant); the
// hosted web deploy never sets it, so every consumer below degrades to exactly
// today's behaviour when the var is absent.

export type WrapperMode = "devices";

/** Reads WRAPPER_MODE from the environment; anything but "devices" is null
 * (no wrapper). Fail-closed to null: an unknown value must never widen scope. */
export function wrapperMode(): WrapperMode | null {
  return process.env.WRAPPER_MODE === "devices" ? "devices" : null;
}

/** The dashboard pages a wrapper-mode build may reach. Everything else under
 * /dashboard redirects away (enforced server-side in proxy.ts — a hidden link
 * is not a guard). */
export const WRAPPER_DEVICES_ALLOWED_PAGES = ["/dashboard/devices", "/dashboard/settings"] as const;

export function isWrapperPageAllowed(pathname: string): boolean {
  return WRAPPER_DEVICES_ALLOWED_PAGES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
