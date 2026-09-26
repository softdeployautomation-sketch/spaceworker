import { NextResponse } from "next/server";
import { requireInternalBearer } from "@/lib/internal-auth";
import { sweepGovernor } from "@/lib/resource-governor";

// TASK_105 — the resource governor's sweep. POST /api/internal/governor-sweep,
// gated by INTERNAL_BEARER_TOKEN, hit by the systemd timer every minute
// (deploy/governor-sweep.timer). Mirrors the clone-sweep route shape: bearer
// gate first, single-flight, then a counts-only JSON body.
//
// Phases, in order (each independently idempotent, so a second tick in the same
// minute is a clean no-op):
//   1. expire waiters that passed governorQueueTimeoutSec;
//   2. close grants old enough that they are no longer a meaningful admission;
//   3. promote free/trial waiters that starved past governorStarvationPromoteMin;
//   4. drain each feature's head while capacity + pressure allow;
//   5. log a normal → warn → hard transition to the audit trail if one happened.
//
// The route always answers 200 once the bearer is valid (single-flight skip
// included): the sweep treats an unreachable/under-pressure phase as "try again
// next tick" rather than surfacing an error the timer would just retry.

// Single-flight: one module-level promise chain. Overlapping timer runs must
// not double-execute (double grants would double-add rows, and the pressure
// transition would be logged twice).
let inFlight: Promise<unknown> | null = null;

export async function POST(req: Request) {
  if (!requireInternalBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (inFlight) {
    return NextResponse.json({ skipped: true }, { status: 200 });
  }
  const run = runSweep();
  inFlight = run;
  try {
    return NextResponse.json(await run, { status: 200 });
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function runSweep() {
  const result = await sweepGovernor();

  // Counts + levels only. Never a userId, ref, token or session URL.
  console.log(
    `[governor-sweep] level ${result.level} (ram ${result.pressure.ramUsedPct}%, swap ${result.pressure.swapUsedMb}MB, load ${result.pressure.load1}), governor ${result.enabled ? "on" : "off"}, expired ${result.expired}, released ${result.released}, promoted ${result.promoted}, granted ${result.granted}, queued ${result.queued}`
  );

  return {
    level: result.level,
    enabled: result.enabled,
    expired: result.expired,
    released: result.released,
    promoted: result.promoted,
    granted: result.granted,
    byFeature: result.byFeature,
    queued: result.queued,
    pressure: {
      measured: result.pressure.measured,
      ramUsedPct: result.pressure.ramUsedPct,
      ramAvailableMb: result.pressure.ramAvailableMb,
      swapUsedMb: result.pressure.swapUsedMb,
      load1: result.pressure.load1,
      cpuCount: result.pressure.cpuCount,
      reason: result.pressure.reason,
    },
    transition: result.transitions.logged
      ? { from: result.transitions.from, to: result.transitions.to }
      : null,
  };
}
