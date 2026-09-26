import { NextResponse } from "next/server";

import { parseApprovalToken } from "@/lib/agent-approval-token";
import {
  executeAgentApprovalTap,
  loadPendingActionForReview,
  AgentApprovalError,
} from "@/lib/agent-approval-executor";
import { renderApprovalPage, renderReviewPage } from "@/lib/agent-approval-page";

export const dynamic = "force-dynamic";

// Task 94's "Edit" deliverable, scoped down to "review, then approve/reject"
// rather than granular field-by-field editing (not in the task's own
// acceptance list, and the payload shapes vary too much by kind — device vs
// job vs campaign — for one generic field editor to be honest about what it
// can safely change). GET shows the full proposal text; POST decides.
// PUBLIC — the signed token IS the auth, same model as approve/reject.

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const parsed = parseApprovalToken(token);
  if (!parsed || parsed.decision !== "review") {
    return html(
      renderApprovalPage({
        title: "Link expired",
        tone: "error",
        message: "This link is invalid or has expired. Open the proposal from the dashboard instead.",
      }),
      403,
    );
  }

  const pending = await loadPendingActionForReview(parsed.pendingActionId);
  if (!pending || pending.status !== "pending" || pending.expiresAt.getTime() <= Date.now()) {
    return html(
      renderApprovalPage({
        title: "No longer pending",
        tone: "error",
        message: "This proposal is no longer pending — it may already be approved, rejected, or expired.",
      }),
      409,
    );
  }

  return html(
    renderReviewPage({
      kind: pending.kind,
      proposal: pending.proposal?.trim() || "(no summary provided)",
      expiresAt: pending.expiresAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
      token,
    }),
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const parsed = parseApprovalToken(token);
  if (!parsed || parsed.decision !== "review") {
    return html(
      renderApprovalPage({
        title: "Link expired",
        tone: "error",
        message: "This link is invalid or has expired. Open the proposal from the dashboard instead.",
      }),
      403,
    );
  }

  const form = await req.formData().catch(() => null);
  const decision = form?.get("decision");
  if (decision !== "approve" && decision !== "reject") {
    return html(
      renderApprovalPage({ title: "Invalid request", tone: "error", message: "No decision was submitted." }),
      400,
    );
  }

  try {
    await executeAgentApprovalTap({
      pendingActionId: parsed.pendingActionId,
      decision,
      approvalChannel: "telegram",
    });
    return html(
      renderApprovalPage({
        title: decision === "approve" ? "Approved" : "Rejected",
        tone: "ok",
        message:
          decision === "approve"
            ? "This proposal has been approved and is now running."
            : "This proposal has been rejected. Nothing was run.",
      }),
    );
  } catch (err) {
    if (err instanceof AgentApprovalError) {
      const status = err.code === "not_found" ? 404 : err.code === "not_pending" ? 409 : 502;
      return html(
        renderApprovalPage({ title: "Couldn't complete this", tone: "error", message: err.message }),
        status,
      );
    }
    console.error("[agent-approval] review-page decision failed:", err);
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
