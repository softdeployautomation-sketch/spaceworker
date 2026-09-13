import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Sets or clears a campaign's human-assisted deliverability fallback address
// (EmailCampaign.testRecipientOverride). Two entry points call this:
//   1. Proactively, at campaign creation (the "use this recipient as my test
//      target instead of Gmail" option next to the manual-insert recipient).
//   2. Reactively, from the campaign detail page's failed-check prompt — after
//      the platform seed mailbox's automated check fails, the user either picks
//      an existing manual_insert recipient already in the queue, or types a new
//      email right there, and this route stores it before they retry the test.
// Only meaningful while the campaign hasn't started sending — matches the
// test-send route's own guard.
//
// POST /api/campaigns/[id]/test-recipient   body: { email: string | null }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({ where: { id, userId: session.userId } });
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (campaign.status === "sending" || campaign.status === "done") {
    return NextResponse.json(
      { error: "Campaign has already started or finished sending" },
      { status: 409 },
    );
  }

  let body: { email?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = typeof body.email === "string" ? body.email.trim() : "";
  // A very light shape check — the actual proof this address works at all is
  // the test-send the caller runs right after this, not this route.
  if (raw && !raw.includes("@")) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  const updated = await prisma.emailCampaign.update({
    where: { id },
    data: { testRecipientOverride: raw || null },
    select: { id: true, testRecipientOverride: true },
  });

  return NextResponse.json(updated);
}
