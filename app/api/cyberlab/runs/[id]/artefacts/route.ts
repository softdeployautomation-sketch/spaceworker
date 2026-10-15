import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { createEpisode, verifyEpisodeSignature, EpisodeCapError } from "@/lib/lab/episode";
import { BRIDGE_MAX_CONTENT_CHARS, isBridgeToolId } from "@/lib/lab/tool-bridge";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156B S7-B (PLAN_CYBERLAB_NEXT_S7 §1 Slice B) — POST
// /api/cyberlab/runs/[id]/artefacts: the tool bridge's return hop. The
// operator did real work in a real tool (mailer / extractor / RMM) and
// brings the output back; this stores it as a SIGNED companion episode via
// the existing createEpisode machinery — same manifest, same signature,
// append-only. The original run's episode is NEVER mutated (there is no
// update path; that is the point of the evidence chain).
//
// SECURITY (mirrors the stream route exactly):
//   - getCurrentUser → 401; module gate → denied response.
//   - A range that is not the caller's is 404 (never 403: no existence oracle).
//   - toolId must be a known bridge tool; content is capped at
//     BRIDGE_MAX_CONTENT_CHARS (the same constant the client checks).
//   - `signatureValid` in the response is RECOMPUTED server-side from the
//     stored row — the client is never handed a verdict it supplied itself.
//   - Episode budget applies (EpisodeCapError → 429): a bridge artefact counts
//     as evidence exactly like any other.

const Body = z.object({
  toolId: z.string().refine(isBridgeToolId, "unknown_bridge_tool"),
  content: z.string().min(1).max(BRIDGE_MAX_CONTENT_CHARS),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const { id } = await params;

  // Owner-scope first: a foreign range id is a 404, before the body is even
  // parsed — the refusal shape must not depend on the caller's input.
  const range = await db.labRange.findUnique({ where: { id } });
  if (!range || range.userId !== user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_artefact_request" }, { status: 400 });
  }

  const now = new Date();
  try {
    const episode = await createEpisode({
      rangeId: range.id,
      userId: user.id,
      scenarioSlug: `bridge-${parsed.data.toolId}`,
      mode: "dry-run",
      techniqueIds: [],
      telemetrySignatures: [],
      timeline: [
        {
          at: now.toISOString(),
          event: "lab.bridge.artefact_attached",
          detail: { toolId: parsed.data.toolId, bytes: Buffer.byteLength(parsed.data.content, "utf8") },
        },
      ],
      artefacts: [
        {
          path: `bridged/${parsed.data.toolId}/${now.getTime()}.txt`,
          content: parsed.data.content,
        },
      ],
      startedAt: now,
      endedAt: now,
      outcome: "bridge-artefact",
    });
    // Recomputed from the STORED row — never echoed from the write path.
    const signatureValid = await verifyEpisodeSignature(episode.id);
    return NextResponse.json({ ok: true, episodeId: episode.id, signatureValid });
  } catch (e) {
    if (e instanceof EpisodeCapError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    return NextResponse.json({ error: "attach_failed" }, { status: 500 });
  }
}
