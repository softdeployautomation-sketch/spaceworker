import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 29, item 6 — resolves a campaign paused by the batch gate
// (status "paused_deliverability" set by the mail-queue drain). Actions:
//   "continue"      — trust the operator / continue anyway, resume sending.
//   "switch_subject" — rotate to the next independent subject (decoupled
//                      campaigns), then resume; no-op subject rotation for legacy
//                      pair campaigns, but still resumes.
//   "stop"           — stop the campaign (terminal). Remaining queued items stay
//                      queued but the campaign never re-enters "sending".
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const campaign = await prisma.emailCampaign.findFirst({ where: { id, userId: session.userId } });
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const action = body.action === "continue" || body.action === "switch_subject" || body.action === "stop"
    ? body.action
    : "continue";

  // Guard against bypassing the whole deliverability gate: this route only ever
  // resolves a batch-gate pause. Without this check, calling it on a campaign
  // that never passed test-send-confirm (e.g. still "pending_test_confirm" or
  // "draft") would jump it straight to "sending" with zero deliverability proof —
  // exactly the outcome the test-send-confirm gate and the batch-probe pause both
  // exist to prevent. "stop" is allowed from any non-terminal state since halting
  // a campaign is always safe.
  if (campaign.status !== "paused_deliverability" && action !== "stop") {
    return NextResponse.json(
      { error: `Campaign is not paused on a deliverability check (status: ${campaign.status})` },
      { status: 409 },
    );
  }

  if (action === "stop") {
    await prisma.emailCampaign.update({ where: { id }, data: { status: "stopped" } });
    return NextResponse.json({ ok: true, status: "stopped" });
  }

  if (action === "switch_subject") {
    // Decoupled campaigns: rotate the independent subject list so the next batch
    // uses the NEXT subject. (bodies stay as-is; a single-item list is held constant.)
    if (Array.isArray(campaign.subjects) && campaign.subjects.length > 1) {
      await prisma.emailCampaign.update({
        where: { id },
        data: { subjects: [...campaign.subjects.slice(1), campaign.subjects[0]], status: "sending" },
      });
    } else {
      await prisma.emailCampaign.update({ where: { id }, data: { status: "sending" } });
    }
    return NextResponse.json({ ok: true, status: "sending" });
  }

  // "continue" — resume from where the drain paused.
  await prisma.emailCampaign.update({ where: { id }, data: { status: "sending" } });
  return NextResponse.json({ ok: true, status: "sending" });
}