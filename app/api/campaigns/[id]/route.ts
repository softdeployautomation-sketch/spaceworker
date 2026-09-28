import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    include: {
      variants: { orderBy: { createdAt: "asc" } },
      items: {
        orderBy: { createdAt: "asc" },
        include: {
          mailbox: { select: { id: true, label: true, username: true } } ,
          variant: { select: { id: true, subject: true, bodyHtml: true } },
        },
      },
      checks: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Task 32 — EmailCampaign has no `mailboxes` relation (it stores ids in
  // mailboxIds), so fetch the configured sending mailboxes (and their Task 30
  // item 4 From addresses) separately for the "manually edit and test" From
  // select.
  const mailboxes = await prisma.mailbox.findMany({
    where: { id: { in: campaign.mailboxIds } },
    select: { id: true, label: true, username: true, fromAddresses: true },
  });

  return NextResponse.json({ ...campaign, mailboxes });
}

// PATCH /api/campaigns/[id]  body: { savedAsTemplate: boolean }
// Lets a user flag/unflag one of their OWN campaigns as reusable — it then
// appears in the "My campaigns" group of the template picker (campaigns page
// + Automations builder) and becomes visible to admins in the Campaign
// Templates tab as a candidate to promote into the general "Ready-made
// templates" group. The only field this route can change today.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  let body: { savedAsTemplate?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.savedAsTemplate !== "boolean") {
    return NextResponse.json({ error: "savedAsTemplate must be a boolean" }, { status: 400 });
  }

  const owned = await prisma.emailCampaign.findFirst({ where: { id, userId: session.userId }, select: { id: true } });
  if (!owned) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.emailCampaign.update({
    where: { id },
    data: { savedAsTemplate: body.savedAsTemplate },
    select: { id: true, savedAsTemplate: true },
  });
  return NextResponse.json(updated);
}

// DELETE /api/campaigns/[id] — permanently removes a campaign the user owns,
// along with its variants/queue items/deliverability checks/link redirects
// (none of those FKs cascade at the DB level, so children are deleted first
// in a transaction). Blocked while a send is actively in-flight ("sending" /
// "paused_deliverability") since the drain loop still holds queue items open
// against this campaign — the user must stop it first (deliverability-decision
// route already exposes that "stop" action).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({
    where: { id, userId: session.userId },
    select: { id: true, status: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (campaign.status === "sending" || campaign.status === "paused_deliverability") {
    return NextResponse.json(
      { error: "Stop this campaign's send before deleting it." },
      { status: 409 }
    );
  }

  await prisma.$transaction([
    prisma.linkRedirect.deleteMany({ where: { campaignId: id } }),
    prisma.deliverabilityCheck.deleteMany({ where: { campaignId: id } }),
    prisma.emailQueueItem.deleteMany({ where: { campaignId: id } }),
    prisma.campaignVariant.deleteMany({ where: { campaignId: id } }),
    prisma.emailCampaign.delete({ where: { id } }),
  ]);

  return NextResponse.json({ ok: true });
}