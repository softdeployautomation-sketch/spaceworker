import "server-only";

import { db } from "./db";

export interface NotificationLogEntry {
  // Owning user id when the notification targets a specific account; null for
  // admin-only / ownerless notifications.
  userId?: string | null;
  eventType: string;
  // The recipient actually targeted for the channel — an email address for the
  // "email" channel, a Telegram chat id for "telegram", the owning user's id for
  // "agent" (there is no external address).
  recipient: string;
  channel: "email" | "telegram" | "agent";
  outcome: "sent" | "failed";
  errorMessage?: string | null;
}

/**
 * Append-only audit record of a real notification send attempt (Task 8). Single
 * shared writer used by every channel in lib/notify.ts AND the email/message
 * senders themselves (lib/email.ts, lib/telegram.ts), so the NotificationLog
 * shows exactly what was tried per user per event, across channels.
 *
 * Additive by design: a failure to write the log row must never change the send
 * outcome the caller observes.
 */
export async function writeNotificationLog(entry: NotificationLogEntry): Promise<void> {
  try {
    await db.notificationLog.create({
      data: {
        userId: entry.userId ?? null,
        eventType: entry.eventType,
        channel: entry.channel,
        recipient: entry.recipient,
        outcome: entry.outcome,
        errorMessage: entry.errorMessage ?? null,
      },
    });
  } catch (err) {
    // Logging is strictly additive — never let it fail (or change the outcome
    // of) the actual send, which is what the caller depends on.
    console.error("Failed to write NotificationLog:", err);
  }
}
