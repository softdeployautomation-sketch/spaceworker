import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { advanceClone, getClone } from "@/lib/clone";

export const dynamic = "force-dynamic";

// TASK_110 (bit B4) — POST /api/clones/[cloneId]/advance.
// Drives the next lifecycle step via advanceClone() (TASK_109) — this is what
// lets the first run progress before the TASK_112 sweep exists. Idempotent and
// safe to call repeatedly: repeated calls return the unchanged state with
// advanced:false, never a second execution.

/** Upstream-shape guard (rule 4): the UI must never render a raw agent/Vantra body. */
function failure(err: unknown): NextResponse {
  const text = sanitize(unknownMessage(err));
  if (/not found/.test(text)) {
    // A raced delete between the owner-scoped read and the advance.
    return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
  }
  if (/unknown state|unhandled state/.test(text)) {
    // Forward-only enforcement (TASK_109): a state the table does not know.
    return NextResponse.json({ error: "clone_state_unknown", reason: text }, { status: 409 });
  }
  // Anything else (DB outage, transport throw): a stable code + generic reason.
  // Engine internals (file paths, Prisma dumps) stay in the server log.
  return NextResponse.json(
    { error: "advance_failed", reason: "The clone could not advance — try again." },
    { status: 502 },
  );
}

/** Never leak a raw upstream body (HTML) into the UI (rule 4). */
function sanitize(message: string): string {
  return /<!DOCTYPE|<html/i.test(message)
    ? "clone_unavailable: the agent answered with an HTML page (deploy outdated?) — check the Vantra deploy."
    : message;
}

function unknownMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ cloneId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { cloneId } = await params;

  try {
    // Owner-scope every read and write (rule 3): a clone belonging to another
    // user is 404 here, before any orchestrator call.
    const existing = await getClone(cloneId, session.userId);
    if (!existing) {
      return NextResponse.json({ error: "not_found", reason: "No such clone." }, { status: 404 });
    }

    const result = await advanceClone(cloneId);
    if (result.queued) {
      // Governor hold (rule 5): 202 with the queue reason, not an error.
      // TASK_105: the honest place in line rides along when the governor is on
      // (queuePosition is absent for a governor-OFF hold, so the console's copy
      // is unchanged from before this task).
      return NextResponse.json(
        {
          ok: true,
          cloneId: result.cloneId,
          status: result.status,
          advanced: false,
          queued: true,
          reason: result.reason,
          ...(result.queuePosition ? { queuePosition: result.queuePosition } : {}),
          ...(result.etaSeconds ? { etaSeconds: result.etaSeconds } : {}),
          ...(result.queuePosition
            ? { message: `Waiting for a free slot — ${result.queuePosition} ahead of you.` }
            : {}),
        },
        { status: 202 },
      );
    }
    return NextResponse.json({
      ok: true,
      cloneId: result.cloneId,
      status: result.status,
      advanced: result.advanced,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  } catch (err) {
    return failure(err);
  }
}
