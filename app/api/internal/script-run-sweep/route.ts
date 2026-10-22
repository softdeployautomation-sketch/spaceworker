import { NextResponse } from "next/server";

import { requireInternalBearer } from "@/lib/internal-auth";

export const dynamic = "force-dynamic";

// POST /api/internal/script-run-sweep — gated by INTERNAL_BEARER_TOKEN, hit by
// deploy/script-run-sweep.timer every 60 seconds.
//
// Fires scheduled runs and auto-enroll runs once their `scheduledFor` has
// passed. Each run is claimed atomically (queued → running) inside the
// dispatcher, so this sweep and an inline "Run now" can never double-execute.
// A small batch per tick keeps the oneshot unit far below its timeout.
export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Dynamic import: the dispatcher pulls the device-tools/vantra-link graph
  // (and lib/env), which must not load merely because a test or the route
  // module is required.
  const { dispatchDueScriptRuns } = await import("@/lib/device-scripts");
  const dispatched = await dispatchDueScriptRuns(6);
  if (dispatched) console.log(`[script-run-sweep] dispatched ${dispatched} run(s)`);
  return NextResponse.json({ ok: true, dispatched });
}
