import "server-only";

import { isSelfHosted } from "./exe-build-target";
import { isSetupComplete } from "./self-hosted-setup-state";

// TASK_130 (§4) — the proxy gate that forces an unconfigured self-hosted
// install through the first-run wizard. Kept in its own module (not inlined in
// proxy.ts) for two reasons:
//   1. proxy.ts is an isolated bundle and Next.js only allows the handler plus
//      `config` to be exported from it — the cache + test seams below need to
//      be real exports.
//   2. it's directly unit-testable without booting Next's proxy machinery.
//
// Confirmed against the Next.js docs before writing this: "v16.0.0 Middleware
// is deprecated and renamed to Proxy. Proxy defaults to the Node.js runtime" —
// so reading the setup-state file here (fs/promises) is supported. This is the
// same class of dependency proxy.ts already takes via @/lib/maintenance
// (Prisma → Node-only), which is further evidence the bundle is Node runtime.
//
// Mirrors the existing allowlist-array style of LICENSE_ONLY_ALLOWED_* in
// proxy.ts rather than inventing a different pattern.

// Everything the wizard itself needs to function, plus Next's own static
// asset surfaces (mostly belt-and-braces — the proxy matcher already excludes
// _next/static, _next/image and favicon.ico).
const SETUP_ALLOWED_PAGE_PREFIXES = ["/setup"];
const SETUP_ALLOWED_API_PREFIXES = ["/api/setup"];
const SETUP_ALLOWED_EXACT = ["/favicon.ico"];

export function isSetupAllowedPath(pathname: string): boolean {
  if (SETUP_ALLOWED_EXACT.includes(pathname)) return true;
  if (pathname.startsWith("/_next/")) return true;
  for (const p of SETUP_ALLOWED_PAGE_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  for (const p of SETUP_ALLOWED_API_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  return false;
}

// Short in-memory cache, same discipline (and same caveat) as
// lib/maintenance.ts's getMaintenanceFlags: this lives in proxy's own isolated
// bundle, so the setup API's invalidateSetupGateCache() call never reaches
// this copy — a wizard completion becomes visible here on the next TTL expiry
// at the latest. A 1s TTL keeps that invisible in practice while sparing the
// hot path a file read per request.
let cache: { completed: boolean; at: number } | null = null;
const CACHE_TTL_MS = 1000;

/** Called by the setup API after writing completedAt (best-effort in-process invalidation). */
export function invalidateSetupGateCache(): void {
  cache = null;
}

async function setupCompleteCached(now: number): Promise<boolean> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.completed;
  let completed = false;
  try {
    completed = await isSetupComplete();
  } catch {
    // readSetupState() already swallows file/JSON errors and returns defaults
    // (no completedAt), so this is only a truly unexpected throw. Treat it as
    // "not complete" — consistent with that default, and with the wizard being
    // a mandatory first-run step rather than something a read hiccup skips.
    completed = false;
  }
  cache = { completed, at: now };
  return completed;
}

/**
 * True when this request should be redirected to /setup. Only ever true for a
 * self-hosted build (isSelfHosted()) whose setup-state file carries no
 * completedAt yet, and never for the wizard's own pages/APIs or static assets.
 * Non-self-hosted (our own hosted SaaS) builds are completely untouched.
 */
export async function shouldRedirectToSetup(pathname: string): Promise<boolean> {
  if (!isSelfHosted()) return false;
  if (isSetupAllowedPath(pathname)) return false;
  return !(await setupCompleteCached(Date.now()));
}
