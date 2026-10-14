import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/admin-auth";
import { verifyEpisodeSignature } from "@/lib/lab/episode";

// TASK_156B C2b (PLAN_TASK_156 §13.3, build order item 3) — admin traceability:
// ONE endpoint listing ALL runs across ALL users, so "we should be able to see
// what happens" is a query, not a promise. Each row carries who/what/targets/
// techniques/outcome plus the signature VERIFIED recomputed from the stored
// episode row (not a stored boolean — a stored boolean could lie).
//
// The attack view is this list + the episode detail endpoint; the defence view
// (telemetry signatures, victim-sensor rows) lives in episodes/[id]. The §5.2
// LabAbuseReports ride the same payload so refusals are visible next to runs —
// silence about refusals would make the trail dishonest.
//
// Admin-scoped: requireAdminSession (403 otherwise), no user-scoping filter.

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [ranges, episodes, reports] = await Promise.all([
    db.labRange.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    db.labEpisode.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    db.labAbuseReport.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  const userIds = [...new Set([...ranges.map((r) => r.userId), ...reports.map((rp) => rp.userId)])];
  const scenarioIds = [...new Set(ranges.map((r) => r.scenarioId))];
  const [users, scenarios] = await Promise.all([
    userIds.length > 0 ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    scenarioIds.length > 0 ? db.labScenario.findMany({ where: { id: { in: scenarioIds } }, select: { id: true, slug: true, name: true, klass: true } }) : [],
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));
  const episodeByRange = new Map(episodes.map((e) => [e.rangeId, e]));

  // Signature validity recomputed per episode from the STORED row — the only
  // form of "valid" an auditor may trust.
  const signatureByRange = new Map<string, boolean>();
  await Promise.all(
    episodes.map(async (e) => {
      signatureByRange.set(e.rangeId, await verifyEpisodeSignature(e.id));
    }),
  );

  return NextResponse.json({
    runs: ranges.map((r) => {
      const ep = episodeByRange.get(r.id) ?? null;
      const scenario = scenarioById.get(r.scenarioId) ?? null;
      const user = userById.get(r.userId) ?? null;
      return {
        rangeId: r.id,
        userId: r.userId,
        userEmail: user?.email ?? null,
        state: r.state,
        error: r.error,
        ttlExpiresAt: r.ttlExpiresAt,
        teardownVerifiedAt: r.teardownVerifiedAt,
        createdAt: r.createdAt,
        scenario: scenario ? { slug: scenario.slug, name: scenario.name, klass: scenario.klass } : null,
        episode: ep
          ? {
              id: ep.id,
              startedAt: ep.startedAt,
              endedAt: ep.endedAt,
              outcome: ep.outcome,
              techniques: ep.techniques,
              telemetrySignatures: ep.telemetrySignatures,
              signedHash: ep.signedHash,
              signatureValid: signatureByRange.get(r.id) ?? false,
            }
          : null,
      };
    }),
    abuseReports: reports.map((rp) => ({
      id: rp.id,
      userId: rp.userId,
      userEmail: userById.get(rp.userId)?.email ?? null,
      rangeId: rp.rangeId,
      reason: rp.reason,
      severity: rp.severity,
      status: rp.status,
      evidenceJson: rp.evidenceJson,
      createdAt: rp.createdAt,
    })),
  });
}
