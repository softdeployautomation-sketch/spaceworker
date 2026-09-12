import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { confirmDailyRun } from "@/lib/automation-run";

// Task 27, Part B — POST /api/automations/[id]/runs/[runId]/confirm
// The user's explicit "yes, send" for a daily run that paused at
// needs_confirmation. Guards the transition and never runs unattended.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, runId } = await params;

  const result = await confirmDailyRun(id, runId, session.userId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}