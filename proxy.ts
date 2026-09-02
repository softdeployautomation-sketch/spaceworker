import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

// Next.js 16 renamed `middleware` to `proxy` (the `middleware.ts` convention is
// deprecated). This file provides the same auth-gate behavior from the plan:
// gate /dashboard/** behind a valid CUSTOMER session cookie, and /admin/** behind
// a valid ADMIN session cookie (defense-in-depth — the admin API routes and
// protected layout gate themselves with jose/cookies too).
//
// Both sessions are verified here with `jose` (Edge-safe, no native bcrypt).
// They use distinct cookie names + issuer/audience from each other AND from
// Vantra's ("vantra_session"/"vantra-admin"), so no session token from any of
// SpaceWorker's sessions is ever interchangeable with Vantra's.

const CUSTOMER_COOKIE = "spaceworker_session";
const CUSTOMER_ISSUER = "spaceworker";
const CUSTOMER_AUDIENCE = "spaceworker";

const ADMIN_COOKIE = "spaceworker_admin_session";
const ADMIN_ISSUER = "spaceworker-admin";
const ADMIN_AUDIENCE = "spaceworker-admin";

const encoder = new TextEncoder();
const secret = () => encoder.encode(process.env.SESSION_SECRET ?? "");

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAdmin = pathname.startsWith("/admin");
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

function redirectTo(request: NextRequest, path: string) {
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};