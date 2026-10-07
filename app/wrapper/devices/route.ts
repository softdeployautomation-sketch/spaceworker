import { NextResponse } from "next/server";

import { WRAPPER_MODE_COOKIE, WRAPPER_MODE_COOKIE_VALUE } from "@/lib/wrapper-mode";

// TASK_183 — the devices wrapper EXE's entry URL (src-tauri/src/main.rs navigates
// its window here). It exists to carry wrapper scope to the HOSTED app: the Tauri
// window runs no local runtime, so scoping (nav narrowing + the /dashboard route
// guard in proxy.ts) rides this session cookie instead of the build-time
// WRAPPER_MODE env. Session cookie in the wrapper's own WebView2 profile — it
// persists across app launches and through the login redirect, and it is never
// set for regular browsers (they land on /dashboard/devices directly and get the
// full app, byte-identical to today).
export function GET(request: Request): NextResponse {
  // RELATIVE Location on purpose: the client resolves it against its own origin
  // (the wrapper webview is on spaceworker.top; dev on localhost:3400). An absolute
  // URL built from `request.url` picked up the box's internal host instead
  // (verified live: Location came back as https://localhost:3500/... which would
  // break the webview), so we never build the target from server-side request info.
  void request;
  const response = new NextResponse(null, { status: 307 });
  response.headers.set("Location", "/dashboard/devices");
  response.cookies.set(WRAPPER_MODE_COOKIE, WRAPPER_MODE_COOKIE_VALUE, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
  });
  return response;
}