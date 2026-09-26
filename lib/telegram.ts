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
 * Fire-and-forget operational alert to the OWNER's fixed Telegram chat (never
 * a customer's) — for events they want to know about immediately: an EXE
 * license binding/transferring to a device, or a new account signing up. A
 * one-line no-op when either the bot token or ADMIN_TELEGRAM_CHAT_ID is
 * unset, and swallows send failures — an alert channel must never be able to
 * break the flow (a license bind, a signup) it's just reporting on.
 */
export async function notifyAdmin(text: string): Promise<void> {
  if (!telegramConfigured() || !env.adminTelegramChatId) return;
  try {
    await sendTelegramMessage(env.adminTelegramChatId, text);
  } catch (err) {
    console.error("[telegram] admin alert failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Thin wrapper around `POST https://api.telegram.org/bot<token>/sendMessage`.
 * Throws when Telegram is unconfigured or the API returns ok:false. Writes a
 * NotificationLog row (best-effort) so the audit trail shows the attempt.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  return sendTelegramMessageInternal(chatId, text);
}

// Task 94 — an inline keyboard is just extra JSON on the same sendMessage
// call (Telegram Bot API `reply_markup.inline_keyboard`, a grid of rows of
// `{text, url}` buttons — using `url` buttons, not `callback_data`, so the
// signed approval token can be as long as it needs to be: callback_data is
// capped at 64 bytes by Telegram itself, far too short for a signed,
// HMAC'd, expiry-embedded token plus a cuid; a URL has no such limit).
export interface TelegramInlineButton {
  text: string;
  url: string;
}

export async function sendTelegramMessageWithButtons(
  chatId: string,
  text: string,
  buttonRows: TelegramInlineButton[][],
): Promise<void> {
  return sendTelegramMessageInternal(chatId, text, {
    inline_keyboard: buttonRows.map((row) => row.map((b) => ({ text: b.text, url: b.url }))),
  });
}

/**
 * Thin wrapper around `POST https://api.telegram.org/bot<token>/sendMessage`.
 * Throws when Telegram is unconfigured or the API returns ok:false. Writes a
 * NotificationLog row (best-effort) so the audit trail shows the attempt.
 */
async function sendTelegramMessageInternal(
  chatId: string,
  text: string,
  replyMarkup?: { inline_keyboard: { text: string; url: string }[][] },
): Promise<void> {
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
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
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
