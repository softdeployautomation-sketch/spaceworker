import { NextResponse } from "next/server";

import { runSummaryPass, summariseViaRelay } from "@/lib/screenshot-summaries";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// TASK_152 M3 — the screen-summary sweep, split out from screenshot-sweep.
//
// WHY IT IS ITS OWN ROUTE: capture and summarisation are independent by design
// (a failed summary must never fail a capture), so they are independently
// drivable. deploy/screenshot-sweep.timer keeps calling the CAPTURE sweep, which
// also runs summaries at the end — this route exists so summaries can backfill a
// device's frames on demand (after turning monitoring on, or after the relay was
// briefly down) without waiting for a capture to be due, and so the pass has its
// own observable HTTP surface.
//
// Same Bearer scheme as every other internal sweep. The caller ships no payload:
// which frames need summarising is a database question, answered by
// listPendingSummaryFrames, never something a client gets to assert.

export async function POST(req: Request) {
  const token = process.env.INTERNAL_BEARER_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  if (!token || token.length === 0 || header !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runSummaryPass(summariseViaRelay);
  return NextResponse.json(result);
}
