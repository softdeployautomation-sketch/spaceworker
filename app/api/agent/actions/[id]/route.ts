import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import {
  AgentActionError,
  approvePendingAction,
  executedActionStatus,
} from "@/lib/agent-executor";

// /api/agent/actions/[id] — approve/reject a pending agent proposal, and poll
// the live outcome of an executed one.
//   PATCH { decision: "approve" | "reject" } — the ONLY path that turns a
//          pending plan into a REAL SearchJob/EmailCampaign (approve). Reject
//          marks it abandoned.
//   GET — live outcome for polling the chat panel ("leads found vs requested",
//         validation split, or the created campaign id).

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const decision = body?.decision;

  if (decision === "reject") {
    const rows = await prisma.agentPendingAction.updateMany({
      where: { id, userId: session.userId, status: "pending", expiresAt: { gt: new Date() } },
      data: { status: "rejected" },
    });
    if (rows.count === 0) {
      return NextResponse.json(
        { error: "This proposal is no longer pending — it may already be approved, rejected, or expired." },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true, decision: "rejected" });
  }

  if (decision !== "approve") {
    return NextResponse.json({ error: "decision must be \"approve\" or \"reject\"" }, { status: 400 });
  }

  try {
    const result = await approvePendingAction({ userId: session.userId, actionId: id });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AgentActionError) {
      // If execution failed after claiming (e.g. no mailboxes configured), free
      // the proposal back up so the user can fix the blocker and retry.
      await prisma.agentPendingAction.updateMany({
        where: { id, userId: session.userId, status: "approved" },
        data: { status: "pending" },
      });
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const status = await executedActionStatus({ userId: session.userId, actionId: id });
  if (!status) {
    return NextResponse.json({ error: "No executed action for this proposal." }, { status: 404 });
  }
  return NextResponse.json(status);
}