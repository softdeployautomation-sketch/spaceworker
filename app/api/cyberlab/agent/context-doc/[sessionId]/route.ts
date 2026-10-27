import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const { sessionId } = await params;

  const session = await db.cyberLabAgentSession.findUnique({
    where: { id: sessionId },
  });
  if (!session || session.userId !== user.id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const docPath = session.contextDocPath;
  if (!docPath || !existsSync(docPath)) {
    return NextResponse.json({ content: "", steps: [] });
  }

  const content = readFileSync(docPath, "utf-8");

  const steps = await db.cyberLabContextDocStep.findMany({
    where: { sessionId },
    orderBy: { stepNo: "asc" },
  });

  return NextResponse.json({ content, steps });
}