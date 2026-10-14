import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/admin-auth";
import { verifyEpisodeSignature } from "@/lib/lab/episode";
import { VICTIM_SENSOR_SCHEMA } from "@/lib/lab/victim-sensor";

// TASK_156B C2b (PLAN_TASK_156 §13.3) — ONE admin episode with the two views:
//   - ATTACK view: the timeline, techniques and signed manifest (what the run did).
//   - DEFENCE view: the telemetry signatures (what a defender would look for) and
//     the victim-sensor envelope if the run captured one (what the victim's own
//     agent recorded — the "other end" the owner asked to see).
// Signature is recomputed from the STORED row; nothing here is trusted from a
// stored boolean. Admin-scoped via requireAdminSession (403 otherwise).

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  const episode = await db.labEpisode.findUnique({ where: { id } });
  if (!episode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [signatureValid, range, user] = await Promise.all([
    verifyEpisodeSignature(episode.id),
    db.labRange.findUnique({ where: { id: episode.rangeId }, select: { id: true, userId: true, state: true, scenarioId: true, teardownVerifiedAt: true, createdAt: true } }),
    db.user.findUnique({ where: { id: episode.userId }, select: { id: true, email: true } }),
  ]);
  const scenario = range
    ? await db.labScenario.findUnique({ where: { id: range.scenarioId }, select: { slug: true, name: true, klass: true } })
    : null;

  // The timeline Json holds { mode, scenarioSlug, entries } (episode writer) —
  // the victim envelope rides the SAME stored Json under `victim` when present.
  const timelineRaw = (episode.timeline ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(timelineRaw.entries) ? timelineRaw.entries : [];
  const victim = (timelineRaw.victim ?? null) as Record<string, unknown> | null;
  const victimPresent = Boolean(victim) || entries.some(
    (e) => typeof e === "object" && e !== null && (e as { event?: string }).event === "victim.sensor",
  );

  return NextResponse.json({
    episode: {
      id: episode.id,
      rangeId: episode.rangeId,
      userId: episode.userId,
      userEmail: user?.email ?? null,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      outcome: episode.outcome,
      createdAt: episode.createdAt,
    },
    scenario,
    rangeState: range?.state ?? null,
    teardownVerifiedAt: range?.teardownVerifiedAt ?? null,
    // ---- ATTACK view ----
    attack: {
      mode: timelineRaw.mode ?? null,
      scenarioSlug: timelineRaw.scenarioSlug ?? null,
      timeline: entries,
      techniques: episode.techniques,
      evidenceManifest: episode.evidenceManifest,
      signedHash: episode.signedHash,
      signatureValid,
    },
    // ---- DEFENCE view ----
    defence: {
      telemetrySignatures: episode.telemetrySignatures,
      victimSensor: victimPresent
        ? { present: true, schema: victim ? ((victim.schema as string) ?? VICTIM_SENSOR_SCHEMA) : VICTIM_SENSOR_SCHEMA, envelope: victim }
        : { present: false, schema: null, envelope: null },
    },
  });
}
