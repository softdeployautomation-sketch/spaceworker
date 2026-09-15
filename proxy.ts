import { jwtVerify, type JWTPayload } from "jose";
import { NextResponse, type NextRequest } from "next/server";

// Next.js 16 renamed `middleware` to `proxy` (the `middleware.ts` convention is
// deprecated). This file provides the same auth-gate behavior from the plan:
// gate /dashboard/** behind a valid CUSTOMER session cookie, and /admin/** behind
// a valid ADMIN session cookie (defense-in-depth — the admin API routes and
// protected layout gate themselves with jose/cookies too).
//
// Task 45 — Central enforcement of the "license_only" session scope, in ONE
// place. A narrow license_only session is only ever issued by the license-claim
// flow (an EXE-only buyer proving email ownership of their license). It must NOT
// unlock the paid web product — so before anything else, a license_only session
// is restricted to an explicit allowlist with zero per-route cooperation, and
// every "full" user is completely untouched.
//
// For the common (full) case this is a cheap cookie read + one HMAC to resolve
// scope from the JWT itself — NO DB round trip (scope lives in the token payload).

const CUSTOMER_COOKIE = "spaceworker_session";
const CUSTOMER_ISSUER = "spaceworker";
const CUSTOMER_AUDIENCE = "spaceworker";

const ADMIN_COOKIE = "spaceworker_admin_session";
const ADMIN_ISSUER = "spaceworker-admin";
const ADMIN_AUDIENCE = "spaceworker-admin";

// The ONLY things a license_only session may reach. Everything else under the
// /dashboard and /api trees — jobs, campaigns, mailboxes, agent, automations,
// browser, internal, admin — is redirected (pages) or 403'd (APIs).
//
// Fixed 2026-09-14, before this branch merged: /api/billing/* and
// /api/store/prices ARE allowlisted — the licenses page's own "Subscribe" button
// links to /pricing, whose checkout flow (components/store.tsx) calls exactly
// these two prefixes (GET /api/store/prices to render the price, then
// POST /api/billing/checkout + /api/billing/submit to actually pay). Without
// this the stated upgrade path (Task 45 item 4 — "Want the full web app too?
// Subscribe") would 403 the instant a license_only user clicked it. Both routes
// already scope correctly to session.userId server-side (confirmed by reading
// them) — the gap was purely this allowlist never having been extended to them.
// /api/auth/login is allowlisted for the SAME reason as /api/auth/logout: after
// setting a real password (the on-ramp below) a license_only user logs OUT and
// back IN through the normal flow so login's own scope-from-tier check
// (app/api/auth/login/route.ts) can promote them to "full" — blocking the login
// POST itself would trap a paying customer in this narrow scope permanently.
const LICENSE_ONLY_ALLOWED_PAGE_PREFIXES = ["/dashboard/licenses", "/login", "/pricing", "/terms", "/privacy"];
const LICENSE_ONLY_ALLOWED_API_PREFIXES = [
  "/api/exe-license",
  "/api/settings",
  "/api/auth/logout",
  "/api/auth/login",
  "/api/billing",
  "/api/store/prices",
];

const encoder = new TextEncoder();
const secret = () => encoder.encode(process.env.SESSION_SECRET ?? "");

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Task 27 Part A — local EXE runtime: the desktop EXE has NO web login by
  // design. Access control is handled entirely by the local <LicenseGate> in the
  // React tree (which is compiled into the EXE and runs offline), and the EXE's
  // bundled server never has a spaceworker_session cookie. So before ANY cookie /
  // session logic runs, short-circuit the whole web auth gate: without this every
  // /dashboard request the EXE makes would 307 -> /login (a HARD blocker — the
  // shipped EXE would be dead on arrival) before DashboardLayout's local-exe
  // branch even gets to run.
  //
  // This mirrors lib/exe-runtime.ts's isLocalExeRuntime() exactly (same
  // fail-closed env check — SPACEWORKER_LOCAL_EXE is ONLY ever true in the
  // Tauri-bundled local runtime's own .env, never on the production host). It is
  // kept inline rather than imported because the middleware deliberately stays a
  // self-contained module that reads process.env directly (same reason it reads
  // SESSION_SECRET above instead of pulling from lib/env.ts), and exe-runtime.ts
  // is marked "server-only" — not worth betting the Edge bundle on it resolving.
  //
  // The bypass ONLY removes the cookie requirement. It does NOT widen anything
  // else: every /api/* route (incl. /api/exe-license/*) still runs its own
  // route-level isLocalExeRuntime() guard, and /admin still gates itself
  // server-side with jose/cookies. This file only ever redirected when a cookie
  // was absent/invalid; in local-exe there is deliberately no cookie to check.
  if (process.env.SPACEWORKER_LOCAL_EXE === "true") {
    return NextResponse.next();
  }

  // Resolve the customer session's scope (if present). We need it to decide
  // whether to apply the license_only restriction below.
  let customerScope = null;
  const customerCookie = request.cookies.get(CUSTOMER_COOKIE)?.value;
  if (customerCookie) {
    try {
      const verified = await jwtVerify(customerCookie, secret(), {
        issuer: CUSTOMER_ISSUER,
        audience: CUSTOMER_AUDIENCE,
      });
      customerScope =
        (verified.payload as JWTPayload & { scope?: string }).scope === "license_only" ? "license_only" : "full";
    } catch {
      customerScope = null; // treat as no session — the dashboard gate below handles it
    }
  }

  // Task 45 — a license_only session gets the narrow allowlist and NOTHING else.
  // This must short-circuit BEFORE the generic auth gate so that (for example)
  // /dashboard/extract is redirected to /dashboard/licenses and /api/jobs 403s,
  // even though the session is technically a valid logged-in one.
  if (customerScope === "license_only") {
    if (isLicenseOnlyAllowed(pathname)) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Forbidden — this account is limited to license access." },
        { status: 403 },
      );
    }
    // Any other page (other /dashboard/*, /admin/*, arbitrary) → licenses.
    return redirectTo(request, "/dashboard/licenses");
  }

  // ---- Everything below is today's behaviour, unchanged for full users ----
  // The generic auth gate only ever applied to the /dashboard and /admin trees
  // (the original matcher). Since /api is now matched too (for the license_only
  // branch above), we must let every other path — including ALL /api routes like
  // /api/auth/*, guest EXE billing, webhooks, /api/internal/* — pass straight
  // through untouched; the existing gate never intercepted them.
  const isDashboard = pathname.startsWith("/dashboard");
  const isAdmin = pathname.startsWith("/admin");
  if (!isDashboard && !isAdmin) {
    return NextResponse.next();
  }

  // The admin login page is public (no session yet) — let it render like the
  // customer /login page (which isn't in the matcher either).
  if (isAdmin && pathname === "/admin/login") {
    return NextResponse.next();
  }

  const cookieName = isAdmin ? ADMIN_COOKIE : CUSTOMER_COOKIE;
  const issuer = isAdmin ? ADMIN_ISSUER : CUSTOMER_ISSUER;
  const audience = isAdmin ? ADMIN_AUDIENCE : CUSTOMER_AUDIENCE;
  const loginPath = isAdmin ? "/admin/login" : "/login";

  const token = request.cookies.get(cookieName)?.value;
  if (!token) {
    return redirectTo(request, loginPath);
  }

  try {
    await jwtVerify(token, secret(), { issuer, audience });
    return NextResponse.next();
  } catch {
    return redirectTo(request, loginPath);
  }
}

function isLicenseOnlyAllowed(pathname: string): boolean {
  // Only ever called for paths actually matched (see config): /dashboard/*, /admin/*, /api/*.
  if (pathname === "/") return true;
  for (const p of LICENSE_ONLY_ALLOWED_PAGE_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  for (const p of LICENSE_ONLY_ALLOWED_API_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  return false;
}

function redirectTo(request: NextRequest, path: string) {
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/api/:path*"],
};