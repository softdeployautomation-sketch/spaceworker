import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { mayEnterSending } from "@/lib/trial";

// POST /api/campaigns/[id]/resume — the counterpart to .../pause. Only ever
// resumes a manual pause (never "paused_deliverability", which has its own
// dedicated continue/switch_subject/stop flow via deliverability-decision, and
// never "stopped", which is terminal by design). Re-entering "sending" goes
// through the SAME trial-tier daily-allowance gate every other entry point
// uses (mayEnterSending) — a manual pause/resume must not be a backdoor around
// the mailer usage cap.
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
    select: { id: true, status: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (campaign.status !== "paused_manual") {
    return NextResponse.json(
      { error: `Campaign is not manually paused (status: ${campaign.status})` },
      { status: 409 }
    );
  }

  const resumed = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.findUnique({ where: { id: session.userId }, select: { tier: true } });
    const allowed = await mayEnterSending(tx, {
      userId: session.userId,
      tier: owner?.tier ?? 0,
      excludeCampaignId: id,
    });
    if (!allowed) return false;
    await tx.emailCampaign.update({
      where: { id },
      data: { status: "sending", sendingStartedAt: new Date() },
    });
    return true;
  });

  if (!resumed) {
    return NextResponse.json(
      { error: "Daily mailer allowance reached — try again later or upgrade." },
      { status: 429 }
    );
  }

  return NextResponse.json({ ok: true, status: "sending" });
}
