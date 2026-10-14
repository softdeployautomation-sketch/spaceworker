// TASK_156 C2a (PLAN_TASK_156 §6 LabEpisode comment, §8 "how we prove") — the
// episode writer: ONE signed, append-only evidence row per run.
//
// Zero schema change (the playbook's additive rule, respected by simply using
// what C1 created): LabEpisode has no `mode`/`scenarioSlug`/`month` columns —
// mode + scenarioSlug ride INSIDE the `timeline` Json, and the monthly cap
// counts rows since the month's start rather than a stored column.
//
// The signature is the point: `evidenceManifest` (paths + SHA-256 + bytes,
// canonical JSON) plus `signedHash` over manifest bound to
// (rangeId, episodeId, startedAt). There is no update API for episodes — the
// row is append-only — and `verifyEpisodeSignature` recomputes the hash from
// the STORED row, so post-hoc edits are detectable, not merely discouraged.

import "server-only";
import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getAdminSettings } from "@/lib/admin-settings";
import {
  buildEvidenceManifest,
  signManifest,
  verifyManifestSignature,
  type EvidenceArtefact,
  type EvidenceManifest,
} from "./evidence";
import type { TimelineEntry } from "./runner";

export class EpisodeCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpisodeCapError";
  }
}

export interface EpisodeWrite {
  rangeId: string;
  userId: string;
  scenarioSlug: string;
  mode: "dry-run" | "live";
  techniqueIds: string[];
  telemetrySignatures: string[];
  timeline: TimelineEntry[];
  /** Raw artefacts of the run. The manifest hashes their exact bytes. */
  artefacts: EvidenceArtefact[];
  /**
   * C2b — the victim-sensor envelope, stored INSIDE the timeline Json (same
   * additive trick mode/scenarioSlug use) so the defence view can show what the
   * victim's own agent recorded, without a schema change.
   */
  victim?: Record<string, unknown> | null;
  startedAt: Date;
  endedAt: Date;
  outcome?: string;
}

/** Enforce the per-user monthly evidence cap (AdminSetting.cyberlabMaxEpisodesPerMonth). */
export async function assertEpisodeBudget(userId: string): Promise<void> {
  const settings = await getAdminSettings();
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const used = await db.labEpisode.count({ where: { userId, createdAt: { gte: monthStart } } });
  if (used >= settings.cyberlabMaxEpisodesPerMonth) {
    throw new EpisodeCapError(`episode cap reached (${used}/${settings.cyberlabMaxEpisodesPerMonth} this month)`);
  }
}

/** Build, sign, and persist one episode. Throws BEFORE writing when over cap. */
export async function createEpisode(write: EpisodeWrite) {
  await assertEpisodeBudget(write.userId);
  const episodeId = randomUUID();
  const manifest = buildEvidenceManifest(write.rangeId, write.artefacts, write.startedAt);
  const signedHash = signManifest(manifest, {
    rangeId: write.rangeId,
    episodeId,
    startedAt: write.startedAt.toISOString(),
  });
  return db.labEpisode.create({
    data: {
      id: episodeId,
      rangeId: write.rangeId,
      userId: write.userId,
      startedAt: write.startedAt,
      endedAt: write.endedAt,
      timeline: {
        mode: write.mode,
        scenarioSlug: write.scenarioSlug,
        entries: write.timeline,
        ...(write.victim ? { victim: write.victim } : {}),
      } as unknown as Prisma.InputJsonValue,
      techniques: write.techniqueIds,
      telemetrySignatures: write.telemetrySignatures,
      outcome: write.outcome ?? write.mode,
      evidenceManifest: manifest as unknown as Prisma.InputJsonValue,
      signedHash,
    },
  });
}

/**
 * Recompute the signature from the STORED row and compare. True only while the
 * row still matches what was signed — this is the "not simulation" primitive
 * (§8): the evidence is verifiable from the row alone, no app trust required.
 */
export async function verifyEpisodeSignature(episodeId: string): Promise<boolean> {
  const ep = await db.labEpisode.findUnique({ where: { id: episodeId } });
  if (!ep || !ep.evidenceManifest || !ep.signedHash || !ep.startedAt) return false;
  return verifyManifestSignature(
    ep.evidenceManifest as unknown as EvidenceManifest,
    { rangeId: ep.rangeId, episodeId: ep.id, startedAt: ep.startedAt.toISOString() },
    ep.signedHash,
  );
}
