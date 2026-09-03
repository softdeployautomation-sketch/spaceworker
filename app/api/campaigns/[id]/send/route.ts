import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function POST(
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
  });
  if (!campaign) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (campaign.status !== "draft") {
    return NextResponse.json(
      { error: "Campaign has already been started" },
      { status: 400 }
    );
  }

  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { status: "sending" },
  });

  return NextResponse.json({ ok: true });
}