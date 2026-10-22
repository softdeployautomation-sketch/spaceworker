import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/scripts/:id/runs?limit=25 — run history, newest first, with output.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ scriptId: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { scriptId } = await params;
  const script = await db.deviceScript.findFirst({
    where: { id: scriptId, userId: session.userId },
    select: { id: true },
  });
  if (!script) return NextResponse.json({ error: "script_not_found" }, { status: 404 });

  const limit = Math.min(
    100,
    Math.max(1, Math.round(Number(new URL(req.url).searchParams.get("limit")) || 25)),
  );
  const runs = await db.deviceScriptRun.findMany({
    where: { scriptId, userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      deviceId: true,
      trigger: true,
      status: true,
      scheduledFor: true,
      startedAt: true,
      finishedAt: true,
      exitCode: true,
      output: true,
      error: true,
      createdAt: true,
      device: { select: { name: true } },
    },
  });
  return NextResponse.json({ runs });
}
