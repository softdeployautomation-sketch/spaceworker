import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { SESSION_SAFE_SELECT } from "@/lib/browser-session-safe-select";
import { serializeSession } from "@/lib/browser-session-serialize";
import { browserRuntime } from "@/lib/browser-runtime";

// GET /api/browser-sessions/[id] — status for the panel to poll.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const row = await prisma.browserSession.findFirst({
    where: { id, userId: session.userId },
    select: SESSION_SAFE_SELECT,
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(serializeSession(row));
}

// DELETE /api/browser-sessions/[id] — stop the session, kill its process, and
// release its BrowserProfile back to idle.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  const row = await prisma.browserSession.findFirst({
    where: { id, userId: session.userId },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (row.status === "stopped" || row.status === "failed") {
    return NextResponse.json({ ok: true });
  }

  // Kill the underlying process/container first (best-effort — even if the
  // runtime is unreachable we still release the profile and close the session).
  const runtimeResult = await browserRuntime.stop(row.id);

  await prisma.$transaction([
    prisma.browserSession.update({
      where: { id: row.id },
      data: { status: "stopped", endedAt: new Date() },
    }),
    prisma.browserProfile.updateMany({
      where: { id: row.profileId, userId: session.userId },
      data: { status: "idle", lastUsedAt: new Date() },
    }),
  ]);

  if (!runtimeResult.ok && runtimeResult.error.includes("unreachable")) {
    return NextResponse.json(
      { ok: true, warning: runtimeResult.error },
      { status: 200 }
    );
  }
  if (!runtimeResult.ok) {
    return NextResponse.json(
      { ok: true, warning: runtimeResult.error },
      { status: 200 }
    );
  }
  return NextResponse.json({ ok: true });
}