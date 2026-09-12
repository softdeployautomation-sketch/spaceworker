import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { kickOffRun } from "@/lib/automation-run";

// Task 27, Part B — POST /api/automations/[id]/run
// "Run now": creates a CampaignAutomationRun and kicks off extraction (a real
// SearchJob enqueued through the same path POST /api/jobs uses) or, for a
// personal-list automation, jumps straight to the send phase. Returns the run id
// so the UI can redirect to the run-detail page.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const automation = await prisma.campaignAutomation.findFirst({
    where: { id, userId: session.userId },
  });
  if (!automation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A paused daily automation is allowed to be run manually too — pause only
  // suppresses the automated sweep, it never locks the "Run now" button.

  try {
    const { runId } = await kickOffRun(automation);
    return NextResponse.json({ runId }, { status: 201 });
  } catch (e) {
    console.error("[automation/run] kickOffRun failed:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to start run." },
      { status: 500 },
    );
  }
}