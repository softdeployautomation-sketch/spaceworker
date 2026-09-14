import "server-only";

import { Prisma } from "@prisma/client";

import { db } from "./db";
import { sendEmail } from "./email";
import { writeNotificationLog } from "./notification-log";
import { sendTelegramMessage, telegramConfigured } from "./telegram";
import type { InlineWidget } from "./agent";

// Task 39 — the shared multi-channel notification dispatcher. Replaces the
// ad-hoc `sendEmail` calls at the two owner-notification sites (daily automation
// needs-confirmation, campaign deliverability pause) with one fan-out that
// honours the user's OWN per-channel preferences and delivers through whatever
// channels they've enabled: email (default on), Telegram (default off, skipped
// unless linked), and the agent chat thread (default on, only when the user has
// an AgentThread).
//
// Best-effort per channel: one channel's failure must never block another's —
// every attempt is wrapped and logged with its own NotificationLog row, so the
// audit trail (per user, per event) records exactly what was tried and whether
// it succeeded.

export interface NotifyUserOptions {
  // Stable event type recorded on every NotificationLog row (e.g.
  // "batch_deliverability_pause", "automation_needs_confirmation").
  eventType: string;
  subject: string; // email subject line
  emailHtml: string; // existing HTML builders, unchanged
  telegramText: string; // short plain-text version for Telegram
  agentText: string; // short plain-text version for the agent chat thread
  // Optional deep link appended to the telegram/agent text (and surfaced as the
  // email CTA by callers who embed runLink themselves).
  link?: string;
  // Optional structured context (Task 37/38 inline widget) attached to the agent
  // message so the "Ask the agent" panel can render it (e.g. a
  // campaign_status_list for the specific paused campaign).
  inlineWidget?: InlineWidget | null;
}

export async function notifyUser(userId: string, opts: NotifyUserOptions): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      notifyEmail: true,
      notifyTelegram: true,
      notifyAgent: true,
      telegramChatId: true,
    },
  });
  if (!user) return;

  const linkSuffix = opts.link ? `\n${opts.link}` : "";

  // --- Email (default on) -----------------------------------------------
  // sendEmail throws on failure but records its own NotificationLog row; we
  // swallow to keep other channels running regardless of email's outcome.
  if (user.notifyEmail && user.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: opts.subject,
        html: opts.emailHtml,
        eventType: opts.eventType,
      });
    } catch {
      // Best-effort — sendEmail already logged outcome:"failed".
    }
  }

  // --- Telegram (default off; a no-op until the user links a chat) -------
  if (user.notifyTelegram && user.telegramChatId) {
    // sendTelegramMessage already throws-if-unconfigured AND logs its own row;
    // still guard so we don't even attempt (or mis-log) when Telegram is off.
    if (telegramConfigured()) {
      try {
        await sendTelegramMessage(
          user.telegramChatId,
          `${opts.telegramText}${linkSuffix}`,
        );
      } catch {
        // Best-effort — sendTelegramMessage already logged outcome:"failed".
      }
    }
  }

  // --- Agent chat thread (default on, only if a thread exists) -----------
  if (user.notifyAgent) {
    try {
      const thread = await db.agentThread.findFirst({ where: { userId } });
      if (thread) {
        const content = `${opts.agentText}${linkSuffix}`;
        await db.agentMessage.create({
          data: {
            threadId: thread.id,
            role: "assistant",
            content,
            // A system-authored notification is NOT a tool turn: no proposal,
            // and the optional widget is the only structured payload.
            toolCall: Prisma.DbNull,
            inlineWidget: opts.inlineWidget
              ? (opts.inlineWidget as Prisma.InputJsonValue)
              : Prisma.DbNull,
          },
        });
        await writeNotificationLog({
          userId,
          eventType: opts.eventType,
          channel: "agent",
          recipient: userId, // no external address for the agent thread
          outcome: "sent",
        });
      }
    } catch (err) {
      await writeNotificationLog({
        userId,
        eventType: opts.eventType,
        channel: "agent",
        recipient: userId,
        outcome: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
