import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

import { getMaintenanceFlags, MAINTENANCE_PAGE_HTML } from "@/lib/maintenance";

const secret = new TextEncoder().encode(process.env.JWT_SECRET!);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Task 56 — admin-toggleable maintenance windows, checked BEFORE the session
  // logic below. Web maintenance serves the maintenance page for everything
  // except /admin/** (the admin must always reach the toggle to turn it off) and
  // static assets. The EXE-API flag makes /api/exe* + /api/exe-license* return a
  // distinguishable 503 { maintenance: true } instead of proceeding — the EXE's
  // hosted-fetch wrapper watches for that shape and retries with a friendly state.
  if (pathname.startsWith("/api/exe") || pathname.startsWith("/api/exe-license")) {
    const flags = await getMaintenanceFlags();
    if (flags.exeApi) {
      return NextResponse.json({ maintenance: true, error: "Maintenance" }, { status: 503 });
    }
  } else if (
    !pathname.startsWith("/admin") &&
    !pathname.startsWith("/_next") &&
    pathname !== "/favicon.ico"
  ) {
    const flags = await getMaintenanceFlags();
    if (flags.web) {
      return new NextResponse(MAINTENANCE_PAGE_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }

  if (pathname.startsWith("/dashboard")) {
    const token = req.cookies.get("sw_session")?.value;
    if (!token) return NextResponse.redirect(new URL("/login", req.url));
    try {
      await jwtVerify(token, secret, { issuer: "spaceworker", audience: "spaceworker_user" });
    } catch {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    const token = req.cookies.get("sw_admin")?.value;
    if (!token) return NextResponse.redirect(new URL("/admin/login", req.url));
    try {
      await jwtVerify(token, secret, { issuer: "spaceworker", audience: "spaceworker_admin" });
    } catch {
      return NextResponse.redirect(new URL("/admin/login", req.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  // Broad matcher so maintenance enforcement covers the whole site (web page
  // + EXE-API routes), not just the authenticated dashboard/admin trees. The
  // session checks above still only act on their own prefixes.
  matcher: ["/:path*"],
};