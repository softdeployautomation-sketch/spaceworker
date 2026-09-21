import { NextResponse } from "next/server";
import { hostname } from "os";
import { z } from "zod";

import { isLocalExeRuntime, HOSTED_APP_URL } from "@/lib/exe-runtime";
import { exeBuildTarget } from "@/lib/exe-build-target";
import { getMachineId } from "@/lib/machine-id";
import { writeTrialStart } from "@/lib/license-state";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email(),
});

// POST /api/exe-license/trial-start — body: { email }
//
// Task 58 — the owner-mandated email-first step (2026-09-21: "the flow should
// take users email from the start, not just allow users to just use the app").
// The shared <LicenseGate> calls THIS route once the user submits a valid email
// on first launch; it is the one required, awaited call that creates the
// server-side ExeTrialSession via the single source of truth (the hosted app's
// /api/exe-license/trial-ping) and persists the server-authoritative startedAt
// locally through writeTrialStart. A returning machine — even one whose local
// state file was deleted — gets its TRUE original startedAt back here (the
// server never resets it), never a fresh 24h.
//
// Local-only (isLocalExeRuntime guard, fail-closed, matching every other EXE
// capability gate): never mounted / routable on the deployed web app, whose
// .env never sets SPACEWORKER_LOCAL_EXE=true.
export async function POST(req: Request) {
  if (!isLocalExeRuntime()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let email: string;
  try {
    email = bodySchema.parse(await req.json()).email;
  } catch {
    return NextResponse.json(
      { error: "A valid email is required to start a trial." },
      { status: 400 },
    );
  }

  const machineId = (await getMachineId()).toLowerCase();
  const product = `${exeBuildTarget()}_exe`;
  const machineLabel = (() => {
    try {
      return hostname();
    } catch {
      return undefined;
    }
  })();

  try {
    const res = await fetch(`${HOSTED_APP_URL}/api/exe-license/trial-ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId, product, email, machineLabel }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            typeof data.error === "string"
              ? data.error
              : "Could not start your trial. Please try again.",
        },
        { status: 502 },
      );
    }
    if (typeof data.startedAt !== "string") {
      return NextResponse.json({ error: "Unexpected server response." }, { status: 502 });
    }
    await writeTrialStart({ trialStartedAt: data.startedAt, email });
    return NextResponse.json({ ok: true, startedAt: data.startedAt });
  } catch {
    return NextResponse.json(
      {
        error:
          "Could not reach the license server. Check your internet connection and try again.",
      },
      { status: 502 },
    );
  }
}