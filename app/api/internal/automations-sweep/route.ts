import { NextResponse } from "next/server";
import { sweepCreateDueDailyRuns, sweepAdvanceFinishedRuns } from "@/lib/automation-run";

// Task 27, Part B — the automation scheduler, a sibling of app/api/internal/dispatch
// and retention-sweep. POST /api/internal/automations-sweep, gated by the same
// INTERNAL_BEARER_TOKEN, meant to be hit by the external scheduler each hour:
//
//   1. Create runs for daily automations due in the current hour (once-per-hour
//      guard inside the helper so a double-firing timer can't double-run).
//   2. Advance any in-flight runs whose extraction SearchJob has reached a
//      terminal state: "done"/"stopped" -> send phase (daily runs stop at
//      needs_confirmation for the user to approve), "failed" -> run failed.
//
// This is NOT a long-lived in-process scheduler — it matches this repo's
// existing dispatcher/queue-drain convention exactly.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const created = await sweepCreateDueDailyRuns();
  const advanced = await sweepAdvanceFinishedRuns();

  console.log(`[automations-sweep] created ${created} daily run(s), advanced ${advanced} run(s)`);

  return NextResponse.json({ createdDailyRuns: created, advancedRuns: advanced });
}