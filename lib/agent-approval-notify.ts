import "server-only";

import { db } from "./db";
import { env } from "./env";
import { sendTelegramMessageWithButtons, telegramConfigured } from "./telegram";
import { mintApprovalToken } from "./agent-approval-token";

// Task 94 — pushes a real, actionable Telegram message the moment a pending
// agent proposal is created, IF the user has both linked Telegram AND opted
// into "Approvals via Telegram" (a separate toggle from the general
// notifyTelegram event-notification preference — see prisma/schema.prisma's
// User.telegramApprovalsEnabled comment). Called from every
// AgentPendingAction creation site (lib/agent.ts for job/campaign,
// lib/vantra-link.ts for device) — fire-and-forget: a Telegram failure must
// never break the proposal itself, which already exists and is approvable
// from the web regardless.

export interface PendingActionForTelegram {
  id: string;
  kind: string;
  proposal: string | null;
}

function baseUrl(): string {
  return env.appBaseUrl.replace(/\/$/, "");
}

export async function notifyPendingActionViaTelegram(opts: {
  userId: string;
  action: PendingActionForTelegram;
}): Promise<void> {
  if (!telegramConfigured()) return;

  const user = await db.user.findUnique({
    where: { id: opts.userId },
    select: { telegramChatId: true, telegramApprovalsEnabled: true },
  });
  if (!user?.telegramChatId || !user.telegramApprovalsEnabled) return;

  const summary = opts.action.proposal?.trim() || `A new ${opts.action.kind} proposal is waiting.`;
  const text = `🤖 SpaceWorker proposal\n\n${summary}\n\nThis expires in a while — review and decide below.`;

  const approveUrl = `${baseUrl()}/api/agent/approve/${mintApprovalToken(opts.action.id, "approve")}`;
  const rejectUrl = `${baseUrl()}/api/agent/reject/${mintApprovalToken(opts.action.id, "reject")}`;
  const reviewUrl = `${baseUrl()}/api/agent/review/${mintApprovalToken(opts.action.id, "review")}`;

  try {
    await sendTelegramMessageWithButtons(user.telegramChatId, text, [
      [
        { text: "✅ Approve", url: approveUrl },
        { text: "❌ Reject", url: rejectUrl },
      ],
      [{ text: "🔍 Review first", url: reviewUrl }],
    ]);
  } catch (err) {
    // Best-effort — sendTelegramMessageWithButtons already logged the
    // outcome via NotificationLog. The proposal itself is unaffected; it
    // stays approvable from the web dashboard regardless.
    console.error(
      `[agent-approval] Telegram push failed for pending action ${opts.action.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
