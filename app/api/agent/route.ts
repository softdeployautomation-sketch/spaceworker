import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ChannelryAiError } from "@/lib/channelry-ai";
import { listThreadMessages, runAgentTurn } from "@/lib/agent";

// /api/agent — the "Ask the agent" chat route.
//   GET  → the user's thread messages + any currently-pending (unapproved) plans.
//   POST → run one agent turn with a user message. The agent may respond with
//          prose alone, or it may propose a job/campaign (stored as a pending
//          AgentPendingAction). It NEVER creates the real job/campaign here —
//          that only happens on Approve (PATCH /api/agent/actions/[id]).

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const messages = await listThreadMessages(session.userId);
  const pending = await prisma.agentPendingAction.findMany({
    where: { userId: session.userId, status: "pending", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, payload: true, proposal: true, expiresAt: true },
  });

  return NextResponse.json({
    messages,
    pending: pending.map((p) => ({
      id: p.id,
      kind: p.kind,
      payload: p.payload,
      proposal: p.proposal,
      expiresAt: p.expiresAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  try {
    const result = await runAgentTurn({ userId: session.userId, message });
    const messages = await listThreadMessages(session.userId);
    return NextResponse.json({ ...result, messages });
  } catch (err) {
    if (err instanceof ChannelryAiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status === 0 ? 503 : (err.status >= 400 ? err.status : 502) }
      );
    }
    throw err;
  }
}