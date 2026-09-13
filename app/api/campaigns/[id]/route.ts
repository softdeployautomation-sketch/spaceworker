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