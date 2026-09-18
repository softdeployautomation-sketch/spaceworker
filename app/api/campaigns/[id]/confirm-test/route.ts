import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { mayEnterSending } from "@/lib/trial";

// POST: the explicit "yes, this delivered, proceed" click. Only unlocks the real
// send if a DeliverabilityCheck for this campaign is "delivered" — not a timer,
// not an assumption. Once confirmed, the campaign moves to "sending", which is the
// only status the mail-queue drain route processes, so this is the gate.
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
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (campaign.status !== "pending_test_confirm") {
    return NextResponse.json(
      { error: `Campaign is not awaiting test confirmation (status: ${campaign.status})` },
      { status: 409 }
    );
  }

  const latest = await prisma.deliverabilityCheck.findFirst({
    where: { campaignId: id },
    orderBy: { createdAt: "desc" },
  });
  if (!latest || latest.status !== "delivered") {
    return NextResponse.json(
      {
        error: "Cannot confirm: the test message was not verified as delivered. Run a successful test-send first.",
      },
      { status: 400 }
    );
  }

  // Tier 1 trial — gate entry into "sending" on the mailer's daily allowance
  // (Premium is exempt). Inside a transaction so the in-flight-campaigns read
  // and the status flip can't race another confirm on a different campaign.
  const updated = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.findUnique({ where: { id: session.userId }, select: { tier: true } });
    const allowed = await mayEnterSending(tx, {
      userId: session.userId,
      tier: owner?.tier ?? 0,
      excludeCampaignId: id,
    });
    if (!allowed) return "trial_cap" as const;
    return tx.emailCampaign.update({
      where: { id },
      data: { status: "sending", sendingStartedAt: new Date() },
    });
  });

  if (updated === "trial_cap") {
    return NextResponse.json(
      { error: "Daily send-time limit reached for your plan. Try again after UTC midnight, or upgrade to Premium." },
      { status: 429 },
    );
  }

  return NextResponse.json(updated);
}