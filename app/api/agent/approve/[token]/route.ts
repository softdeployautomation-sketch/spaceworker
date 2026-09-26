import { NextResponse } from "next/server";

import { parseApprovalToken } from "@/lib/agent-approval-token";
import { executeAgentApprovalTap, AgentApprovalError } from "@/lib/agent-approval-executor";
import { renderApprovalPage } from "@/lib/agent-approval-page";

export const dynamic = "force-dynamic";

// Task 94 — the URL a Telegram "✅ Approve" button opens directly. PUBLIC (no
// session — the signed token IS the auth), single-use in effect (the bound
// AgentPendingAction's own pending->approved transition is atomic; a re-tap
// or network retry hits "not_pending" and changes nothing further).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const parsed = parseApprovalToken(token);
  if (!parsed || parsed.decision !== "approve") {
    return html(
      renderApprovalPage({
        title: "Link expired",
        tone: "error",
        message: "This approval link is invalid or has expired. Open the proposal from the dashboard instead.",
      }),
      403,
    );
  }

  try {
    await executeAgentApprovalTap({
      pendingActionId: parsed.pendingActionId,
      decision: "approve",
      approvalChannel: "telegram",
    });
    return html(
      renderApprovalPage({
        title: "Approved",
        tone: "ok",
        message: "This proposal has been approved and is now running.",
      }),
    );
  } catch (err) {
    if (err instanceof AgentApprovalError) {
      const status = err.code === "not_found" ? 404 : err.code === "not_pending" ? 409 : 502;
      return html(
        renderApprovalPage({ title: "Couldn't approve", tone: "error", message: err.message }),
        status,
      );
    }
    console.error("[agent-approval] approve tap failed:", err);
    return html(
      renderApprovalPage({
        title: "Something went wrong",
        tone: "error",
        message: "Please try again from the SpaceWorker dashboard.",
      }),
      502,
    );
  }
}

function html(body: string, status = 200): NextResponse {
  return new NextResponse(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
