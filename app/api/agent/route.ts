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
  // 2026-09-27 — the floating widget's own mute switch, plus the existing
  // agent-actions kill switch surfaced here too so the widget's own settings
  // panel can show/edit it without a second round trip (additive fields; the
  // automations page's existing consumer of this route just ignores them).
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { agentWidgetEnabled: true, agentActionsEnabled: true },
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
    widgetEnabled: user?.agentWidgetEnabled ?? true,
    agentActionsEnabled: user?.agentActionsEnabled ?? true,
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { message?: unknown; pageContext?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }
  // Widget page-awareness — a short client-supplied label, capped so a caller
  // can never smuggle a large payload into every turn's AI call.
  const pageContext =
    typeof body?.pageContext === "string" ? body.pageContext.trim().slice(0, 300) : undefined;

  try {
    const result = await runAgentTurn({ userId: session.userId, message, pageContext });
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