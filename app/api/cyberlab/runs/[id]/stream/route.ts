import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { mapEventToStage, targetsFromTimeline } from "@/lib/lab/console-map";
import { verifyEpisodeSignature } from "@/lib/lab/episode";
import type { TimelineEntry } from "@/lib/lab/runner";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

/** Prisma stores these as Json? — narrow to real strings, never trust the shape. */
function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}


// TASK_156B UI-1 (PLAN_CYBERLAB_STANDALONE_UI.md §2 "live transport = SSE",
// §3 S2) — GET /api/cyberlab/runs/[id]/stream: the Operation Console's event
// feed. The house SSE pattern (same frame encoding + headers as
// app/api/exe/advanced-search/run/route.ts — text/event-stream over a
// ReadableStream, no new infra).
//
// Frame shape (stable; later phases extend, never reshape):
//   open     — {rangeId, state, mode, scenarioSlug, live, startedAt, targets}
//   event    — {at, event, detail, stage}    one per REAL timeline entry
//   evidence — {path, sha256, bytes}         one per signed manifest row
//   done     — {state, outcome, techniques, telemetrySignatures, signedHash,
//               signatureValid, teardownVerifiedAt}
//
// HONEST LIMIT (in the payload, not just a comment): `live` is false today —
// the C2a engine is SYNCHRONOUS (startLabRun completes the whole run inside
// the POST), so by the time a client opens this stream the run is a stored,
// signed episode. The frames are that episode's REAL timeline, replayed with
// its REAL `at` timestamps; the console labels the pane REPLAY accordingly.
// When async execution lands, the same route sets live:true and pushes while
// the range is active — the frame shape is already the live shape.
//
// SECURITY: owner-scoped exactly like episodes/[id] — a range that is not the
// caller's is 404 (never 403: no existence oracle), module gate applied, and
// `signatureValid` is RECOMPUTED server-side from the stored row so the client
// can never be handed a signature verdict it supplied itself.

const encoder = new TextEncoder();

type Frame =
  | {
      type: "open";
      rangeId: string;
      state: string;
      mode: string;
      scenarioSlug: string | null;
      live: false;
      startedAt: string | null;
      targets: Array<{ kind: string; value: string }>;
    }
  | { type: "event"; at: string; event: string; detail: Record<string, unknown> | null; stage: string }
  | { type: "evidence"; path: string; sha256: string; bytes: number }
  | {
      type: "done";
      state: string;
      outcome: string | null;
      techniques: string[];
      telemetrySignatures: string[];
      signedHash: string | null;
      signatureValid: boolean | null;
      teardownVerifiedAt: string | null;
    };

function sseFrame(ev: Frame): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

interface ManifestRow {
  entries?: Array<{ path: string; sha256: string; bytes: number }>;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const { id } = await ctx.params;
  // Owner-scope the range: a foreign id is a 404, identical to "no such run" —
  // the caller can never learn whether another account's range id exists.
  const range = await db.labRange.findFirst({ where: { id, userId: user.id } });
  if (!range) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const episode = await db.labEpisode.findFirst({ where: { rangeId: range.id, userId: user.id } });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (ev: Frame) => controller.enqueue(sseFrame(ev));
      try {
        const timelineJson = (episode?.timeline ?? null) as {
          mode?: string;
          scenarioSlug?: string;
          entries?: TimelineEntry[];
          victim?: unknown;
        } | null;
        const entries: TimelineEntry[] = Array.isArray(timelineJson?.entries) ? timelineJson!.entries! : [];
        const mode = typeof timelineJson?.mode === "string" ? timelineJson.mode : "dry-run";
        const scenarioSlug = typeof timelineJson?.scenarioSlug === "string" ? timelineJson.scenarioSlug : null;

        push({
          type: "open",
          rangeId: range.id,
          state: range.state,
          mode,
          scenarioSlug,
          // False while runs are synchronous: this is a replay of a stored,
          // signed episode (see header). Live pushes flip this later.
          live: false,
          startedAt: episode?.startedAt ? episode.startedAt.toISOString() : null,
          targets: targetsFromTimeline(entries),
        });

        for (const e of entries) {
          push({
            type: "event",
            at: e.at,
            event: e.event,
            detail: (e.detail ?? null) as Record<string, unknown> | null,
            stage: mapEventToStage(e.event),
          });
        }

        const manifest = (episode?.evidenceManifest ?? null) as ManifestRow | null;
        for (const m of manifest?.entries ?? []) {
          push({ type: "evidence", path: m.path, sha256: m.sha256, bytes: m.bytes });
        }

        push({
          type: "done",
          state: range.state,
          outcome: episode?.outcome ?? null,
          techniques: jsonStringArray(episode?.techniques),
          telemetrySignatures: jsonStringArray(episode?.telemetrySignatures),
          signedHash: episode?.signedHash ?? null,
          // Recomputed from the STORED row (verifyEpisodeSignature) — null when
          // the run never produced an episode (failed before signing).
          signatureValid: episode ? await verifyEpisodeSignature(episode.id) : null,
          teardownVerifiedAt: range.teardownVerifiedAt ? range.teardownVerifiedAt.toISOString() : null,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

