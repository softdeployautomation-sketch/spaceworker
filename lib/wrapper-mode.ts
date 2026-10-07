import "server-only";

import { cookies } from "next/headers";

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

// ---------------------------------------------------------------------------
// TASK_183 — cookie-carried wrapper scoping for the HOSTED window.
//
// The devices wrapper EXE is a Tauri window onto the HOSTED app (it never runs
// a local runtime — see src-tauri/src/main.rs): it navigates to
// GET /wrapper/devices, which sets this session cookie and 307s into
// /dashboard/devices. The hosted web deploy never sets the cookie, so every
// consumer degrades to exactly today's behaviour (env path unchanged for
// dev/tests via run-exe-dev.sh's WRAPPER_MODE). The cookie is UX scope only —
// real protection stays server-side (entitlement gates, TASK_181 P2).
// ---------------------------------------------------------------------------

/** Cookie that carries wrapper scope on the hosted app. Session cookie, set
 * only by the /wrapper/devices entry route (HttpOnly, Secure, SameSite=Lax). */
export const WRAPPER_MODE_COOKIE = "sw_wrapper";

/** The only cookie VALUE that means wrapper scope. Fail-closed like the env:
 * anything else is null. */
export const WRAPPER_MODE_COOKIE_VALUE: WrapperMode = "devices";

/** Pure parser for cookie values (proxy.ts reads `request.cookies` directly —
 * it cannot await next/headers). Fail-closed: unknown ⇒ null. */
export function wrapperModeFromCookieValue(value: string | undefined | null): WrapperMode | null {
  return value === WRAPPER_MODE_COOKIE_VALUE ? WRAPPER_MODE_COOKIE_VALUE : null;
}

/** Server-component resolver: env FIRST (dev/tests unchanged, and an env flag
 * must always outrank a spoofed cookie), then the request's cookie jar. Used by
 * app/dashboard/layout.tsx and app/dashboard/settings/page.tsx. */
export async function resolveWrapperMode(): Promise<WrapperMode | null> {
  const fromEnv = wrapperMode();
  if (fromEnv) return fromEnv;
  const jar = await cookies();
  return wrapperModeFromCookieValue(jar.get(WRAPPER_MODE_COOKIE)?.value);
}
