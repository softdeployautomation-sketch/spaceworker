import { NextResponse } from "next/server";
import { desktopOnlyInterstitialHtml, isMobileUserAgent, recordLinkClick, resolveLink } from "@/lib/hosting/links";

// Task 30, item 3 — public link-redirect route: GET /r/<token>.
//
// World-readable by design (a redirect URL sits in a recipient's inbox, so the
// token is NOT a bearer secret — it's an opaque lookup key; see lib/link-cloak.ts
// for the explicit scope). A valid key 302-redirects to the stored target and
// increments a plain per-link click counter (aggregate only, no timestamps or
// per-recipient attribution — explicitly out of scope for this pass). An
// unknown/expired key must respond with a clean, non-exception 404 — never a
// raw stack trace.
//
// TASK_155 P2 — `<token>` may now ALSO be a user's friendly SLUG: the P2 short
// links (created in the Hosting tab) resolve on this exact route, so a friendly
// link and a campaign's cloaked link behave identically. The lookup moved into
// lib/hosting/links.ts (slug first, then token); campaign links have a NULL slug
// so their behaviour is unchanged (P2 acceptance).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params; // MUST await — async in Next.js 16
  const link = await resolveLink(token);
  if (!link) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // TASK_175 — Desktop-only gate, decided AFTER resolving so expired/revoked
  // semantics never change (a missing link still 404s above). Flag off, or an
  // explicit ?desktop=1 bypass (the interstitial's "Continue anyway"), or a
  // desktop UA → today's 302 byte-identical. Flag on + mobile UA → the white
  // "open on your PC" interstitial, no redirect. The interstitial view counts
  // the click (the user DID open the link); the bypass counts again on the
  // follow-up 302 like any second open.
  const url = new URL(req.url);
  const bypassed = url.searchParams.get("desktop") === "1";
  if (link.desktopOnly && !bypassed && isMobileUserAgent(req.headers.get("user-agent"))) {
    void recordLinkClick(link.id);
    const continueUrl = `/r/${encodeURIComponent(token)}?desktop=1`;
    return new NextResponse(desktopOnlyInterstitialHtml(continueUrl), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" },
    });
  }

  // Best-effort + fire-and-forget: increment the counter, then redirect. A
  // failure to count must never break the redirect the recipient clicked. Not
  // awaited — a slow counter write must not add latency to a redirect.
  void recordLinkClick(link.id);

  return NextResponse.redirect(link.target, 302);
}
