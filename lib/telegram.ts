import "server-only";

import { randomBytes } from "node:crypto";

import { db } from "./db";
import { env } from "./env";
import { writeNotificationLog } from "./notification-log";

// SpaceWorker's own outbound Telegram channel (Task 39). Mirrors lib/email.ts's
// error-handling shape: throws with a clear message on failure, and the caller
// decides whether to swallow. Bot API docs: https://core.telegram.org/bots/api

// A link token is valid for this long before the webhook rejects it as expired.
export const TELEGRAM_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function telegramConfigured(): boolean {
  return Boolean(env.telegramBotToken);
}

/**
 * Thin wrapper around `POST https://api.telegram.org/bot<token>/sendMessage`.
 * Throws when Telegram is unconfigured or the API returns ok:false. Writes a
 * NotificationLog row (best-effort) so the audit trail shows the attempt.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const eventType = "telegram_send";
  let outcome: "sent" | "failed" = "sent";
  let errorMessage: string | null = null;

  try {
    if (!telegramConfigured()) {
      throw new Error("TELEGRAM_BOT_TOKEN is not configured — cannot send Telegram message");
    }
    const url = `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || body.ok !== true) {
      // 401 from Telegram on a revoked/invalid token, 400 on a banned chat, etc.
      throw new Error(body.description ?? `Telegram returned HTTP ${res.status}`);
    }
  } catch (err) {
    outcome = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    // Best-effort link to the owning user — mirrors lib/email.ts's own lookup-by-
    // recipient pattern so Telegram rows are just as attributable in the audit
    // trail as email ones, instead of always showing userId: null. A lookup
    // failure must never affect the send outcome the caller observes.
    let userId: string | null = null;
    try {
      const user = await db.user.findFirst({ where: { telegramChatId: chatId }, select: { id: true } });
      userId = user?.id ?? null;
    } catch {
      // Swallow — logging is strictly additive.
    }
    await writeNotificationLog({
      userId,
      eventType,
      channel: "telegram",
      recipient: chatId,
      outcome,
      errorMessage,
    });
  }
}

/**
 * Build the short-lived, single-use token that backs the "Connect Telegram"
 * deep link (`https://t.me/<username>?start=<token>`). Format:
 * `<crypto-random>.<expiryEpochMs>` — the webhook parses the expiry so an
 * "expired" token can never link to the wrong account.
 */
export function generateTelegramLinkToken(): string {
  const random = randomBytes(16).toString("base64url");
  const expiresAt = Date.now() + TELEGRAM_LINK_TTL_MS;
  return `${random}.${expiresAt}`;
}

export interface ParsedTelegramLinkToken {
  // The user-supplied random half; matched against User.telegramLinkToken.
  random: string;
  expiresAt: number;
}

/**
 * Parse a `/start <token>` payload into its { random, expiresAt } halves, or
 * null if the shape is invalid / the token is already expired. Validity of the
 * random half against a User row is checked by the caller (webhook).
 */
export function parseTelegramLinkToken(raw: string): ParsedTelegramLinkToken | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  const random = raw.slice(0, dot);
  const expiresAt = Number(raw.slice(dot + 1));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { random, expiresAt };
}
