import { NextResponse } from "next/server";
import { requireInternalBearer } from "@/lib/internal-auth";
import { db } from "@/lib/db";
import { expireClones, refreshRelayHealth } from "@/lib/clone";
import { sweepCloneStaging, sweepClonePurge } from "@/lib/clone-sweep";

// Task 112 (bit B6) — clone expiry + staging teardown + 30-day purge sweep.
// POST /api/internal/clone-sweep, gated by INTERNAL_BEARER_TOKEN, hit by the
// systemd timer every 5 minutes (deploy/clone-sweep.timer). Mirrors the
// digest-sweep route shape: bearer gate first, then the four phases in
// order, then a counts-only JSON body.
//
// Order: TTL enforcement -> relay health -> staging teardown -> record
// purge. Each phase is independently idempotent, so two consecutive runs
// converge: the second is a clean no-op. Failures inside one phase never
// abort the later phases; the route always answers 200 when the bearer is
// valid (single-flight skip included).

// Single-flight: one module-level promise chain. Overlapping timer runs
// must not double-execute (double expiry writes double audits, double
// relay probes double device load). If a run is already in flight, answer
// { skipped: true } with 200 — the in-flight run covers the work.
let inFlight: Promise<unknown> | null = null;

// Relay health is time-sensitive but device load is real: probe at most
// this many relay rows per run, oldest-check first.
const RELAY_BATCH_SIZE = 25;

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
    const body = await run;
    return NextResponse.json(body, { status: 200 });
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

async function runSweep() {
  const expired = await expireClones();
  const expiredCount = expired.expiredIdle + expired.expiredHard;

  let relaysChecked = 0;
  try {
    const relays = await db.relayHealth.findMany({
      select: { deviceId: true },
      orderBy: { lastCheckAt: "asc" },
      take: RELAY_BATCH_SIZE,
    });
    for (const { deviceId } of relays) {
      try {
        await refreshRelayHealth(deviceId);
        relaysChecked += 1;
      } catch {
        // Per-relay probe errors are stamped inside refreshRelayHealth;
        // a throw here must not abort the sweep. Count nothing, move on.
      }
    }
  } catch {
    // Relay table unreadable: staging + purge still run below.
  }

  const staging = await sweepCloneStaging();
  const purge = await sweepClonePurge();

  // Counts + clone ids only. Never staging paths, cookie counts per
  // profile, session URLs, tokens, or anything from inside a capture.
  console.log(
    `[clone-sweep] expired ${expiredCount} (idle ${expired.expiredIdle}, hard ${expired.expiredHard}, errors ${expired.errors}), relays ${relaysChecked}, staging ${staging.stagingDeleted} (errors ${staging.errors}), purged ${purge.purged} (errors ${purge.errors})`
  );
  return {
    expired: expiredCount,
    relaysChecked,
    stagingDeleted: staging.stagingDeleted,
    purged: purge.purged,
  };
}
