import "server-only";

import { db } from "./db";
import { recordAgentActionAudit } from "./devices";
import { approvePendingAction, AgentActionError } from "./agent-executor";
import { approveDeviceAction } from "./vantra-link";

// Task 94 — the ONE place a signed Telegram tap turns into the SAME
// execution every other approval channel already uses (CROSS-TRACK RULE 1:
// "the gate is absolute and singular" — this file adds a channel, never a
// second gate). `kind: "device"` proposals already had an
// `approvalChannel` parameter built in (lib/vantra-link.ts's
// approveDeviceAction, "web" today); job/campaign proposals
// (lib/agent-executor.ts's approvePendingAction) had no audit trail at all
// for approval, so this wraps it with one rather than modifying that
// executor's own signature.

export type AgentApprovalDecision = "approve" | "reject";

export interface AgentApprovalOutcome {
  ok: true;
  decision: AgentApprovalDecision;
}

export class AgentApprovalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

async function loadPendingAction(pendingActionId: string) {
  return db.agentPendingAction.findUnique({
    where: { id: pendingActionId },
    select: { id: true, userId: true, kind: true, status: true, expiresAt: true, proposal: true },
  });
}

/**
 * Resolves a signed token's pendingActionId to the row it's for — used by
 * the /review page (which needs to SHOW the proposal before the visitor
 * decides, unlike approve/reject which act immediately).
 */
export async function loadPendingActionForReview(pendingActionId: string) {
  const row = await loadPendingAction(pendingActionId);
  if (!row) return null;
  return row;
}

/**
 * Executes an approve or reject via the Telegram (or any non-web,
 * token-authenticated) channel. Kind-dispatches to the SAME executor the
 * web UI uses — never a parallel implementation. Every tap is audited here
 * with `approvalChannel: "telegram"`, in addition to whatever the
 * underlying executor already records for the device path.
 */
export async function executeAgentApprovalTap(opts: {
  pendingActionId: string;
  decision: AgentApprovalDecision;
  approvalChannel: string;
}): Promise<AgentApprovalOutcome> {
  const pending = await loadPendingAction(opts.pendingActionId);
  if (!pending) throw new AgentApprovalError("This proposal no longer exists.", "not_found");

  if (opts.decision === "reject") {
    if (pending.kind === "device") {
      const rows = await db.agentPendingAction.updateMany({
        where: { id: pending.id, status: "pending", expiresAt: { gt: new Date() } },
        data: { status: "rejected" },
      });
      if (rows.count === 0) {
        throw new AgentApprovalError(
          "This proposal is no longer pending — it may already be approved, rejected, or expired.",
          "not_pending",
        );
      }
      await db.deviceAction.updateMany({
        where: { pendingActionId: pending.id, status: "requested" },
        data: { status: "rejected" },
      });
    } else {
      const rows = await db.agentPendingAction.updateMany({
        where: { id: pending.id, userId: pending.userId, status: "pending", expiresAt: { gt: new Date() } },
        data: { status: "rejected" },
      });
      if (rows.count === 0) {
        throw new AgentApprovalError(
          "This proposal is no longer pending — it may already be approved, rejected, or expired.",
          "not_pending",
        );
      }
    }
    await recordAgentActionAudit({
      userId: pending.userId,
      pendingActionId: pending.id,
      action: `agent_${pending.kind}_reject`,
      status: "rejected",
      approvalChannel: opts.approvalChannel,
    });
    return { ok: true, decision: "reject" };
  }

  // Approve.
  if (pending.kind === "device") {
    try {
      await approveDeviceAction({
        userId: pending.userId,
        pendingActionId: pending.id,
        approvalChannel: opts.approvalChannel,
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : "approve_failed";
      throw new AgentApprovalError(
        code === "not_pending"
          ? "This proposal is no longer pending — it may already be approved, rejected, or expired."
          : "Approval failed — please try again from the web dashboard.",
        code,
      );
    }
  } else {
    try {
      await approvePendingAction({ userId: pending.userId, actionId: pending.id });
    } catch (err) {
      if (err instanceof AgentActionError) {
        // "not_pending" means approvePendingAction's OWN atomic claim found
        // the row already not-pending and changed NOTHING — there is no
        // stray "approved" claim of OURS to free back up. Reverting here
        // unconditionally (matching an earlier draft, and the same pattern
        // in app/api/agent/actions/[id]/route.ts) is a real race: if a
        // DIFFERENT request concurrently WON the claim (row is genuinely
        // "approved" by them, mid-execution) while THIS request's own claim
        // attempt lost and threw "not_pending", the blind revert below would
        // un-claim the WINNING request's row back to "pending" — letting a
        // third attempt execute the same proposal again. Found by this
        // file's own test suite (a seeded already-"approved" row got
        // reverted to "pending" by a losing re-tap). Only revert for an
        // error that happened AFTER a successful claim (i.e. anything
        // that isn't "not_pending").
        if (err.code !== "not_pending") {
          await db.agentPendingAction.updateMany({
            where: { id: pending.id, status: "approved" },
            data: { status: "pending" },
          });
        }
        throw new AgentApprovalError(err.message, err.code);
      }
      throw err;
    }
    // approvePendingAction has no audit trail of its own (see file header) —
    // this IS the record for job/campaign approvals via any channel.
    await recordAgentActionAudit({
      userId: pending.userId,
      pendingActionId: pending.id,
      action: `agent_${pending.kind}_approve`,
      status: "approved",
      approvalChannel: opts.approvalChannel,
    });
  }

  return { ok: true, decision: "approve" };
}
