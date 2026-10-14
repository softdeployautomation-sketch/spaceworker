import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { clientIp } from "@/lib/lab/consent";
import { startLabRun, LabRunRefusedError } from "@/lib/lab/engine";
import { EpisodeCapError } from "@/lib/lab/episode";
import { RangeTransitionError } from "@/lib/lab/range";
import { TargetRefusedError } from "@/lib/lab/targets";
import { VictimDeviceRefusedError } from "@/lib/lab/victim-sensor";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C2a (PLAN_TASK_156 §7 C2 item 4) — the run API.
// POST /api/cyberlab/runs starts one dry-run through lib/lab/engine.startLabRun
// (the ONE orchestrator: gate → scenario → daily cap → governor slot →
// pre-flight → range lifecycle → synthetic telemetry → signed episode →
// verified teardown). Refusals map to honest status codes, and a pre-flight
// refusal is ALREADY in LabAbuseReport by the time the 403 is returned.
// GET  returns the caller's recent ranges (the run history view).

const StartBody = z.object({
  scenarioSlug: z.string().min(1).max(120).optional(),
  targets: z
    .array(z.object({ kind: z.enum(["host", "network", "url", "domain", "email"]), value: z.string().min(1).max(512) }))
    .min(1)
    .max(32),
  // C2b (§13 BYOT) — the caller's OWN device ids acting as the victim sensor.
  // The server never trusts these as an ownership claim: the sensor's userId-
  // scoped query decides readability and a miss is a §5.2 refusal (403).
  victimDeviceIds: z.array(z.string().min(1).max(64)).max(8).optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const parsed = StartBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_run_request" }, { status: 400 });

  try {
    const result = await startLabRun({
      userId: user.id,
      scenarioSlug: parsed.data.scenarioSlug,
      targets: parsed.data.targets,
      sourceIp: clientIp(req),
      victimDeviceIds: parsed.data.victimDeviceIds,
    });
    return NextResponse.json({
      ok: true,
      mode: result.mode,
      rangeId: result.rangeId,
      episodeId: result.episodeId,
      scenarioSlug: result.scenarioSlug,
      targets: result.targets,
      techniques: result.techniques,
      telemetrySignatures: result.telemetrySignatures,
      timeline: result.timeline,
      signedHash: result.signedHash,
      verified: result.verified,
      victim: result.victim,
    });
  } catch (err) {
    if (err instanceof TargetRefusedError) {
      return NextResponse.json({ error: err.message, issues: err.issues }, { status: 403 });
    }
    if (err instanceof VictimDeviceRefusedError) {
      // The §5.2 report is already written by the sensor; the caller just gets
      // the honest refusal (never "the device wasn't found" — that would leak
      // whether an id exists on another account).
      return NextResponse.json({ error: err.message, missing: err.missing }, { status: 403 });
    }
    if (err instanceof LabRunRefusedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof EpisodeCapError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof RangeTransitionError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error("cyberlab run failed", err);
    return NextResponse.json({ error: "run_failed" }, { status: 500 });
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const ranges = await db.labRange.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return NextResponse.json({
    runs: ranges.map((r) => ({
      id: r.id,
      scenarioId: r.scenarioId,
      state: r.state,
      ttlExpiresAt: r.ttlExpiresAt,
      teardownVerifiedAt: r.teardownVerifiedAt,
      error: r.error,
      createdAt: r.createdAt,
    })),
  });
}
