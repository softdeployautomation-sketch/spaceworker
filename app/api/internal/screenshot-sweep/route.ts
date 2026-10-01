import { NextResponse } from "next/server";

import { captureViaService, runCapturePass } from "@/lib/device-screenshots";
import { runSummaryPass, summariseViaRelay } from "@/lib/screenshot-summaries";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// TASK_127 Phase 1 — the capture sweep. Driven by deploy/screenshot-sweep.timer
// (oneshot curl every minute), EXACTLY like governor-sweep / clone-sweep /
// digest-sweep. That is not stylistic: it is the only way this can work here.
//
// WHY THE ORCHESTRATION IS IN THE APP AND NOT A STANDALONE SCRIPT: the deploy
// artifact is `.next node_modules package.json package-lock.json prisma
// browser-server worker deploy` — `lib/` is never shipped to the VPS, and the
// modules this needs (`lib/device-screenshots`, `lib/db`, `lib/auth`) all
// `import "server-only"`, whose default entry throws in a plain Node process.
// A standalone sweep could therefore neither resolve nor import them. The app is
// the one place they exist, and a route costs nothing extra to run.
//
// WHERE THE BROWSER LIVES: not here. `runCapturePass` takes the browser work as
// an INJECTED function, and the function below delegates each frame to
// browser-capture/server.ts over loopback Bearer (its own service, alongside
// browser-server). So this route does all the database work and owns no browser
// footprint, and the capture service owns the browser and knows no database.
//
// Authority to act: the sweep runs as the DEVICE'S OWNER, because that is
// honestly what it is doing — viewing that owner's device through that owner's
// console. The token comes from the app's own `createSessionToken` (the same
// call the login route makes), is used once, and is never logged or persisted.
//
// `captureViaService` itself now lives in lib/device-screenshots.ts, shared
// with the manual "capture now" trigger (app/api/devices/[id]/screenshots/
// capture/route.ts) so both real callers run the exact same tested
// implementation instead of two copies drifting.

export async function POST(req: Request) {
  // Bearer auth first, so an unauthenticated request never reads a setting row,
  // never touches the database and never burns a slot.
  const token = process.env.INTERNAL_BEARER_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  if (!token || token.length === 0 || header !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runCapturePass(captureViaService);

  // TASK_152 M3 — the summary pass runs AFTER the capture pass and IN ITS OWN
  // try/catch, so a summarisation problem can never turn a successful capture
  // into a failed sweep response. The two fail independently: if the relay is
  // down, the frames are still captured and the sweep still reports them; the
  // frames simply carry a summaryError until a later pass succeeds.
  let summaries: unknown;
  try {
    summaries = await runSummaryPass(summariseViaRelay);
  } catch (err) {
    summaries = {
      error: err instanceof Error ? err.message : "summary_pass_failed",
    };
  }

  return NextResponse.json({ ...result, summaries });
}
