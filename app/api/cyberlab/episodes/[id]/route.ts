import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { verifyEpisodeSignature } from "@/lib/lab/episode";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C2a — one evidence episode, with the signature VERIFIED on read.
// `signatureValid` is recomputed from the STORED row (manifest + binding
// context), so this endpoint is the public verifier: whoever holds an episode
// id can check the evidence was not edited after signing — no app trust needed.

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const { id } = await ctx.params;
  const episode = await db.labEpisode.findFirst({ where: { id, userId: user.id } });
  if (!episode) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const signatureValid = await verifyEpisodeSignature(episode.id);
  return NextResponse.json({
    episode: {
      id: episode.id,
      rangeId: episode.rangeId,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      timeline: episode.timeline,
      techniques: episode.techniques,
      telemetrySignatures: episode.telemetrySignatures,
      outcome: episode.outcome,
      evidenceManifest: episode.evidenceManifest,
      signedHash: episode.signedHash,
      createdAt: episode.createdAt,
    },
    signatureValid,
  });
}
