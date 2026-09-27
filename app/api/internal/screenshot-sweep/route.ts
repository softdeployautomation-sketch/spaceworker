import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import {
  frameRelPathFromAbs,
  runCapturePass,
  type CaptureFn,
  type CaptureOutcome,
} from "@/lib/device-screenshots";

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

/** Never let an unexpected upstream body become the row's failure reason. */
function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

const captureViaService: CaptureFn = async (device, framePath): Promise<CaptureOutcome> => {
  // Re-check liveness at capture time, not just when the due list was built: the
  // device can go to sleep in between, and the console's own Connect button is
  // disabled for an offline machine — so the only possible outcomes would be a
  // confusing failure row and a wasted slot.
  const fresh = await db.device.findUnique({
    where: { id: device.id },
    select: { status: true, user: { select: { email: true, emailVerified: true } } },
  });
  if (!fresh || fresh.status !== "online") return { failureReason: "device_offline" };

  // The one thing this process hands over that is secret, and it is scoped to
  // the owner's own console session.
  const token = await createSessionToken({
    sub: device.userId,
    email: fresh.user.email,
    emailVerified: fresh.user.emailVerified,
    scope: "full",
  });

  const base = new URL(env.appBaseUrl);
  const serviceUrl = process.env.SCREENSHOT_CAPTURE_URL ?? "http://127.0.0.1:3403";
  const serviceToken = process.env.SCREENSHOT_CAPTURE_TOKEN;
  if (!serviceToken) {
    // A clear, actionable reason rather than a generic fetch error: this is the
    // one piece of configuration the capture service and the app must agree on.
    return { failureReason: "capture_service_token_not_set" };
  }

  let response: Response;
  try {
    response = await fetch(`${serviceUrl}/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        consoleUrl: `${env.appBaseUrl}/console/${device.id}`,
        cookieName: SESSION_COOKIE,
        cookieValue: token,
        cookieDomain: base.hostname,
        secureCookie: base.protocol === "https:",
        outputPath: framePath,
      }),
      // Slightly longer than the service's own 75s watchdog so the service's
      // specific failure reason wins the race instead of a bare client abort.
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    // The service being down must never look like a device problem.
    return { failureReason: `capture_service_unreachable: ${shortReason(err)}` };
  }

  if (!response.ok) {
    return { failureReason: `capture_service_http_${response.status}: ${shortReason(await response.text())}` };
  }

  const body = (await response.json()) as {
    ok?: boolean;
    failureReason?: string;
    bytes?: number;
    width?: number;
    height?: number;
  };
  if (!body.ok) return { failureReason: body.failureReason ?? "capture_failed" };

  // The service reports the true file size; the RELATIVE path is this side's job
  // because this side owns the storage root (lib/device-screenshots), and doing
  // it through the library keeps the row's path in the one canonical form.
  return {
    filePath: frameRelPathFromAbs(framePath),
    bytes: body.bytes,
    width: body.width,
    height: body.height,
  };
};

export async function POST(req: Request) {
  // Bearer auth first, so an unauthenticated request never reads a setting row,
  // never touches the database and never burns a slot.
  const token = process.env.INTERNAL_BEARER_TOKEN;
  const header = req.headers.get("authorization") ?? "";
  if (!token || token.length === 0 || header !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runCapturePass(captureViaService);
  return NextResponse.json(result);
}
