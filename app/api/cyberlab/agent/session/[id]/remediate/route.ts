import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import {
  generateRemediationFixList,
  createSignedEpisodeForSession,
} from "@/lib/lab/cline-agent";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body as { action?: "fixlist" | "episode" | "both" };
  if (!action || !["fixlist", "episode", "both"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  let fixList: Awaited<ReturnType<typeof generateRemediationFixList>> | null = null;
  let episode: Awaited<ReturnType<typeof createSignedEpisodeForSession>> | null = null;

  if (action === "fixlist" || action === "both") {
    fixList = await generateRemediationFixList(id, user.id);
  }

  if (action === "episode" || action === "both") {
    if (action === "both" && fixList) {
      // Episode creation already calls generateRemediationFixList internally;
      // skip the duplicate call by calling createSignedEpisodeForSession directly.
    }
    episode = await createSignedEpisodeForSession(id, user.id);
  }

  return NextResponse.json({
    ok: true,
    sessionId: id,
    action,
    fixList: fixList
      ? {
          totalFindings: fixList.totalFindings,
          findings: fixList.findings,
          fixReportMd: fixList.fixReportMd,
        }
      : null,
    episode: episode
      ? {
          episodeId: episode.episodeId,
          signedHash: episode.signedHash,
          findingsCount: episode.findingsCount,
        }
      : null,
  });
}