import { NextResponse } from "next/server";

import { parseApprovalToken } from "@/lib/agent-approval-token";
import { executeAgentApprovalTap, AgentApprovalError } from "@/lib/agent-approval-executor";
import { renderApprovalPage } from "@/lib/agent-approval-page";

export const dynamic = "force-dynamic";

// Task 94 — the URL a Telegram "❌ Reject" button opens directly. Mirrors
// approve/[token]/route.ts exactly; see its header comment for the auth
// model (the signed token IS the auth; no session).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const parsed = parseApprovalToken(token);
  if (!parsed || parsed.decision !== "reject") {
    return html(
      renderApprovalPage({
        title: "Link expired",
        tone: "error",
        message: "This link is invalid or has expired. Open the proposal from the dashboard instead.",
      }),
      403,
    );
  }

  try {
    await executeAgentApprovalTap({
      pendingActionId: parsed.pendingActionId,
      decision: "reject",
      approvalChannel: "telegram",
    });
    return html(
      renderApprovalPage({
        title: "Rejected",
        tone: "ok",
        message: "This proposal has been rejected. Nothing was run.",
      }),
    );
  } catch (err) {
    if (err instanceof AgentApprovalError) {
      const status = err.code === "not_found" ? 404 : err.code === "not_pending" ? 409 : 502;
      return html(
        renderApprovalPage({ title: "Couldn't reject", tone: "error", message: err.message }),
        status,
      );
    }
    console.error("[agent-approval] reject tap failed:", err);
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
