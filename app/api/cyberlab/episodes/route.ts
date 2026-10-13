import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getCurrentUser } from "@/lib/session-user";

// TASK_156 C2a — the caller's evidence episodes (newest first). Owner-scoped
// by construction: the query is filtered on the session user, never a body
// parameter, so an episode can never be listed across accounts.

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const episodes = await db.labEpisode.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return NextResponse.json({
    episodes: episodes.map((e) => ({
      id: e.id,
      rangeId: e.rangeId,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      outcome: e.outcome,
      techniques: e.techniques,
      telemetrySignatures: e.telemetrySignatures,
      signedHash: e.signedHash,
      createdAt: e.createdAt,
    })),
  });
}
