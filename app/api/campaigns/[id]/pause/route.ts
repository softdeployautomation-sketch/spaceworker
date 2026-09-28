import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { finalizeMailerStretch } from "@/lib/trial";

// POST /api/campaigns/[id]/pause — a plain manual pause, distinct from
// "paused_deliverability" (an automated gate the mail-queue drain sets when a
// spam-placement probe can't be confirmed) and from "stopped" (terminal — the
// deliverability-decision route's "stop" action never re-enters "sending").
// "paused_manual" is deliberately its own status so resuming later
// (POST .../resume) is unambiguous: only a manually-paused campaign can be
// manually resumed. Only meaningful from "sending" — pausing anything else
// would just be a confusing status jump.
export async function POST(
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
    select: { id: true, userId: true, status: true, sendingStartedAt: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (campaign.status !== "sending") {
    return NextResponse.json(
      { error: `Campaign is not sending (status: ${campaign.status})` },
      { status: 409 }
    );
  }

  await prisma.$transaction(async (tx) => {
    await finalizeMailerStretch(tx, {
      id: campaign.id,
      userId: campaign.userId,
      sendingStartedAt: campaign.sendingStartedAt,
    });
    await tx.emailCampaign.update({ where: { id }, data: { status: "paused_manual" } });
  });

  return NextResponse.json({ ok: true, status: "paused_manual" });
}
