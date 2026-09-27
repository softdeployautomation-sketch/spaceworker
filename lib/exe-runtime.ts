import "server-only";
import { isSelfHosted } from "@/lib/exe-build-target";

// Fixed 2026-09-14, before this branch merged to main: /api/exe-license/status
// and /api/exe-license/activate are part of THIS SAME Next.js codebase — the
// one deployed to the public web server — not a separate app. There is no
// build-time route-exclusion system yet (that's the "four build targets, one
// core" work Task 27 Part A still has ahead of it), so without an explicit
// guard, both routes would have been live, unauthenticated, unlimited-rate
// endpoints on production: /status runs OS commands (machine-id derivation)
// and writes local trial-state files to the SERVER's own filesystem on every
// call, and /activate would validate real license keys against the real
// EXE_LICENSE_SECRET (the server needs that same secret for issuance, so it's
// present in the production .env) for anyone who asked, with no rate limit.
//
// Fail CLOSED, matching this codebase's established discipline for every
// other capability gate (ADMIN_TOKEN, INTERNAL_BEARER_TOKEN,
// EXE_LICENSE_SECRET all refuse when unset, never fall open): only the
// Tauri-bundled local runtime's own .env ever sets SPACEWORKER_LOCAL_EXE=true.
// It must NEVER be set in the production VPS's .env — these routes are inert
// there by default, exactly as intended until real build-variant exclusion
// lands.
export function isLocalExeRuntime(): boolean {
  return process.env.SPACEWORKER_LOCAL_EXE === "true";
}

// Confirmed live (2026-09-19): the marketing homepage/pricing page compile into
// the EXE's bundled local runtime same as everything else, but that runtime has
// NO DATABASE_URL (runtime-assemble.mjs deliberately strips the repo .env before
// packing it — see that script's own comment). Clicking "Sign in" / "Get
// started" from inside the EXE hit the LOCAL /api/auth/login|signup, which threw
// immediately (Prisma with no database) — a real internal-error page, not a
// hypothetical. There is no account to create or session to start locally;
// these always need the real server. Hardcoded rather than read from lib/env.ts
// because APP_BASE_URL is NOT one of the vars the assembler writes into the
// EXE's .env.local either — reading it here would throw at import time inside
// the very runtime this guards.
export const HOSTED_APP_URL = "https://spaceworker.top";

/** Resolves an account path ("/signup", "/login") to the hosted app's real URL
 * when rendering inside the local EXE runtime; unchanged (relative) everywhere
 * else, including the real deployed web app.
 *
 * A self-hosted build (Phase 1, 2026-09-27) is explicitly excluded from this
 * redirect even while running as a local EXE runtime: there is no "our hosted
 * account" for a self-hosted customer to sign into or buy a license from —
 * that customer's own instance IS the whole product. Falling through to the
 * plain `path` here means callers (LicenseGate, ExeLicensePanel, the
 * marketing/pricing pages if a self-hosted build somehow renders them) get an
 * ordinary local link instead of a link to spaceworker.top. NOTE: this does
 * NOT yet change what those links say ("Sign in" / "Buy a license" copy) — see
 * TASK_129 §2 for why that's deliberately left to the Phase 5 license-wizard
 * work instead of stubbed here. */
export function accountHref(path: string): string {
  if (isSelfHosted()) return path;
  return isLocalExeRuntime() ? `${HOSTED_APP_URL}${path}` : path;
}
