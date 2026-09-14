import { NextResponse } from "next/server";

import { clearSessionCookie, getSession, setSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashLicenseClaimToken } from "@/lib/license-claim";

// GET /api/exe-license/claim?token=...  (URL from the license-issued email)
//
// Task 45 — the actual "let an EXE-only buyer see their key" fix. A buyer who
// paid for an EXE product but never had a web account gets a genuine account via
// findOrCreateUser, but with a NON-marketable random password and `tier: 0`. If
// they could log in normally they'd get the ENTIRE web product for free (the
// only tier gate is the browser session). This route gives them access to NOTHING
// but their licenses: it only ever issues the narrow "license_only" scope, and
// only to the inline-created buyer who proves they own the license's email by
// possessing this single-use, time-limited link.
//
// Rules (exact-match discipline, mirroring the Telegram webhook):
//   - invalid / unknown token            -> clear "not recognized" message
//   - expired token                      -> clear "expired" message
//   - already-consumed token             -> clear "already used" message
//   - an already-logged-in FULL session  -> no-op redirect to /dashboard/licenses
//                                            (NEVER downgrade a real session)
//   - a real (normally-signed-up) customer without a session -> /login (they log
//     in with their real password; we never hand them an artificial session)
//   - otherwise (inline buyer)           -> consume token, set license_only cookie,
//                                            redirect to /dashboard/licenses
export async function GET(req: Request) {
  let rawToken = "";
  try {
    rawToken = new URL(req.url).searchParams.get("token") ?? "";
  } catch {
    // unreachable in practice; keep the naive guard
  }
  const token = rawToken.trim();

  if (!token) {
    return messagePage(
      "Missing or invalid claim link.",
      "The link you opened didn't include a valid token. Please use the exact link from your license email.",
    );
  }

  const license = await db.exeLicense.findUnique({
    where: { licenseClaimTokenHash: hashLicenseClaimToken(token) },
  });
  if (!license) {
    return messagePage(
      "We couldn't recognize this license claim link.",
      "The link may be from an old or different account. If you still have it, copy the link exactly from your license email and try again.",
    );
  }

  const now = new Date();
  if (license.licenseClaimTokenExpiresAt && now.getTime() > license.licenseClaimTokenExpiresAt.getTime()) {
    return messagePage(
      "This license claim link has expired.",
      "Please reply to your license email or contact support for a fresh link, or sign in to your SpaceWorker account from the login page.",
    );
  }
  if (license.licenseClaimTokenConsumedAt) {
    return messagePage(
      "This license claim link has already been used.",
      "It can only be opened once. You're already able to view your licenses — if you were signed out, log in or use a fresh link.",
    );
  }

  const user = await db.user.findUnique({ where: { id: license.userId } });
  if (!user) {
    return messagePage(
      "We couldn't find the account for this license.",
      "Please contact support so we can sort this out.",
    );
  }

  const activeSession = await getSession();

  // A currently-logged-in FULL session already owns this as a real customer's
  // view — this claim is a deliberate no-op. Never downgrade an existing real
  // session (the "bought an EXE while already a real customer" case).
  if (activeSession && activeSession.scope === "full") {
    return NextResponse.redirect(new URL("/dashboard/licenses", req.url));
  }

  // The buyer already holds a license_only session for this very license — send
  // them straight to it (no need to re-consume the token).
  if (activeSession && activeSession.sub === user.id && activeSession.scope === "license_only") {
    return NextResponse.redirect(new URL("/dashboard/licenses", req.url));
  }

  // A genuinely real customer (signed up normally, has a real password — the
  // inline-created buyer is the exact opposite: acceptedTermsAt is null because
  // they never went through signup). They must log in the normal way; handing
  // them a session via a claim link would be both wrong and unnecessary.
  if (user.acceptedTermsAt !== null) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // This is the inline-created EXE buyer. Consume the token (single-use), clear
  // any unrelated session, then issue the narrow license_only scope.
  await db.exeLicense.update({
    where: { id: license.id },
    data: { licenseClaimTokenConsumedAt: now },
  });

  if (activeSession && activeSession.sub !== user.id) {
    // A different account's session is active (e.g. someone's personal account
    // while claiming a key on another email). Sign that out so the claim lands
    // cleanly — the claim session belongs to the license owner.
    await clearSessionCookie();
  }

  await setSessionCookie({
    sub: user.id,
    email: user.email,
    emailVerified: true,
    scope: "license_only",
  });

  return NextResponse.redirect(new URL("/dashboard/licenses", req.url));
}

/** Renders a small, self-contained message page (no redirect/API gymnastics). */
function messagePage(title: string, body: string): NextResponse {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f4f6;margin:0;padding:48px 16px;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb;">
      <p style="font-size:20px;font-weight:700;margin:0 0 12px;color:#111827;">${title}</p>
      <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 20px;">${body}</p>
      <a href="/login" style="display:inline-block;border-radius:8px;background:#4f46e5;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 18px;">Sign in</a>
    </div>
  </body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}