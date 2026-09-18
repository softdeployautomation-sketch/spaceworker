import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdminSession } from "@/lib/admin-auth";
import { controlService, getServiceState } from "@/lib/services-control";

// Task 48 — "Stop worker & pause all runs" / "Resume" for the admin Search
// Queue tab. Distinct from the coarse per-service Start/Stop on the Services
// tab (which only toggles systemd and leaves the dispatch toggles + running
// jobs untouched). This is the coordinated hard-stop the owner asked for after
// the earlier incident where the only "stop" was restarting the whole
// spaceworker.service and bringing every customer's site down:
//
//   stop   → one DB transaction (dispatch lanes off + every running job marked
//            "stopped", atomically), THEN the extraction-worker process is
//            killed. Leads already found are kept (persisted on every ~10s
//            poll tick); a hard-stopped job's remaining queries are lost.
//   resume → flips the dispatch toggles back on and starts the worker.

const WORKER_UNIT = "extraction-worker.service";

async function readWorkerState() {
  return getServiceState(WORKER_UNIT);
}

// GET — live state of the extraction worker for the panel's badge/memory line.
export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    return NextResponse.json({ state: await readWorkerState() });
  } catch (err) {
    return NextResponse.json(
      { error: "Couldn't read worker state", detail: String(err) },
      { status: 502 }
    );
  }
}

// POST — body: { action: "stop" | "resume" }.
export async function POST(req: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const action = String((body as Record<string, unknown>).action ?? "");

  try {
    if (action === "stop") {
      // One DB transaction: turn both dispatch lanes off AND mark every
      // currently-running job "stopped" BEFORE the worker process is killed
      // below — so the DB and the worker can't disagree about what's live.
      // Marking running jobs stopped (not their queued entries — those stay
      // "queued" and simply won't dispatch while the lanes are off, then pick
      // right back up on Resume) is the honest semantics of a hard stop.
      await prisma.$transaction([
        prisma.adminSetting.upsert({
          where: { id: "singleton" },
          update: { dispatchLightEnabled: false, dispatchHeavyEnabled: false },
          create: { dispatchLightEnabled: false, dispatchHeavyEnabled: false },
        }),
        prisma.searchJob.updateMany({
          where: { status: "running" },
          data: { status: "stopped", error: null },
        }),
      ]);
      await controlService(WORKER_UNIT, "stop");
    } else if (action === "resume") {
      await prisma.adminSetting.upsert({
        where: { id: "singleton" },
        update: { dispatchLightEnabled: true, dispatchHeavyEnabled: true },
        create: { dispatchLightEnabled: true, dispatchHeavyEnabled: true },
      });
      await controlService(WORKER_UNIT, "start");
    } else {
      return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: "Worker control failed", detail: String(err) },
      { status: 502 }
    );
  }

  // Return the fresh state so the panel can update without a second fetch.
  try {
    return NextResponse.json({ ok: true, state: await readWorkerState() });
  } catch {
    return NextResponse.json({ ok: true });
  }
}