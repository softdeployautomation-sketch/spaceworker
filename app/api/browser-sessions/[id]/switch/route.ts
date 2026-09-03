import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { browserRuntime } from "@/lib/browser-runtime";
import { getExitNode } from "@/lib/exit-nodes";
import { proxyServerValue as buildProxyArg } from "@/lib/browser-proxy";

// POST /api/browser-sessions/[id]/switch — switch a FREE-route session to a
// different exit node mid-session. Requires a process restart (Chrome is already
// pointed at the old proxy), which the browser subsystem performs atomically.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { exitNodeId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const exitNodeId = String(body.exitNodeId ?? "");
  if (!exitNodeId) {
    return NextResponse.json({ error: "exitNodeId is required" }, { status: 400 });
  }

  const row = await prisma.browserSession.findFirst({
    where: { id, userId: session.userId, status: "running" },
  });
  if (!row) {
    return NextResponse.json({ error: "Session not found or not running" }, { status: 404 });
  }
  if (row.proxyMode !== "free") {
    return NextResponse.json(
      { error: "Switching locations only applies to free-route sessions" },
      { status: 400 }
    );
  }

  const node = getExitNode(exitNodeId);
  if (!node) {
    return NextResponse.json({ error: "Selected exit node is not configured" }, { status: 400 });
  }

  const profile = await prisma.browserProfile.findFirst({
    where: { id: row.profileId, userId: session.userId },
  });
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const proxyArg = buildProxyArg({ scheme: node.scheme, host: node.host, port: node.port });
  const runtimeResult = await browserRuntime.restart({
    sessionId: row.id,
    profileDir: profile.dirPath,
    proxyServerValue: proxyArg,
  });
  if (!runtimeResult.ok) {
    return NextResponse.json(
      { error: `Failed to switch route: ${runtimeResult.error}` },
      { status: 502 }
    );
  }

  await prisma.browserSession.update({
    where: { id: row.id },
    data: {
      exitNodeId,
      byoProxyHost: null,
      byoProxyPort: null,
      byoProxyScheme: null,
      byoProxyUsername: null,
      byoProxyAuth: null,
    },
  });

  return NextResponse.json({ ok: true });
}