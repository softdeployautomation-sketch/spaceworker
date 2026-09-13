import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Task 30, item 3 — public link-redirect route: GET /r/<token>.
//
// World-readable by design (a redirect URL sits in a recipient's inbox, so the
// token is NOT a bearer secret — it's an opaque lookup key; see lib/link-cloak.ts
// for the explicit scope). A valid token 302-redirects to the stored target and
// increments a plain per-link click counter (aggregate only, no timestamps or
// per-recipient attribution — explicitly out of scope for this pass). An
// unknown/expired token must respond with a clean, non-exception 404 — never a
// raw stack trace.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params; // MUST await — async in Next.js 16
  const link = await prisma.linkRedirect.findUnique({ where: { token } });
  if (!link) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Best-effort + follow: increment the counter, then redirect. A failure to
  // count must never break the redirect the recipient clicked.
  try {
    await prisma.linkRedirect.update({
      where: { id: link.id },
      data: { clickCount: { increment: 1 } },
    });
  } catch {
    // ignore — the redirect proceeds regardless
  }

  return NextResponse.redirect(link.target, 302);
}