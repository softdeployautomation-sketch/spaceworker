import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  parseTelegramLinkToken,
  sendTelegramMessage,
  telegramConfigured,
} from "@/lib/telegram";

// Telegram calls this route on ANY bot interaction (a /start with our deep-link
// token, most commonly). NOT session-authed — its only trust boundary is the
// X-Telegram-Bot-Api-Secret-Token header set at setWebhook time, which must be
// present and correct (fails CLOSED when unset/mismatched).

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
  edited_message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

// Constant-time compare so a timing side-channel can't leak the secret length.
function secretMatches(given: string): boolean {
  return env.telegramWebhookSecret.length > 0 && given === env.telegramWebhookSecret;
}

export async function POST(req: Request) {
  // Fail closed: no secret configured, or the request doesn't carry the exact
  // header value Telegram echoes from setWebhook => reject outright.
  const supplied = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!secretMatches(supplied)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!telegramConfigured()) {
    // Bot token missing — can't reply, but logging the update as received is
    // still safe. Reject so Telegram retries once the operator notices.
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true }); // unparseable body — ack & move on
  }

  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim() ?? "";

  // TEMPORARY (2026-09-26 live incident) — a real /start still isn't linking
  // even after the @username-suffix fix. Logging the raw shape (no secrets:
  // chat id + message text only) to see what's actually arriving. Remove
  // once the real cause is found.
  console.log("[telegram-webhook-debug]", JSON.stringify({ chatId, text, rawUpdate: update }));

  // A bot can receive lots of unrelated traffic; only act on a /start with a
  // link token — everything else is just acknowledged.
  //
  // 2026-09-26 (live incident): Telegram clients don't always send a bare
  // "/start <token>" — some paths (confirmed live: a deep link opened from a
  // browser preview page, not the app) send "/start@BrandappBot <token>"
  // instead, with the bot's own username appended to the command. The old
  // regex only matched the bare form, so a real, valid /start silently never
  // matched — the route still 200'd (everything unmatched just gets
  // acknowledged), so nothing ever surfaced as an error; the token just sat
  // unconsumed forever. `(?:@\w+)?` makes the mention suffix optional.
  const match = /^\/start(?:@\w+)?\s+(.+)$/.exec(text);
  const token = match ? match[1].trim() : "";
  if (!chatId || !token) {
    return NextResponse.json({ ok: true });
  }

  const chatIdStr = String(chatId);

  // Reject expired / malformed tokens (shape includes an embedded expiry).
  const parsed = parseTelegramLinkToken(token);
  if (!parsed) {
    await reply(chatIdStr, "This link has expired. Open a fresh one from Settings → Notifications and try again.");
    return NextResponse.json({ ok: true });
  }

  // Exact-match the full stored token — a forged-but-plausible raw token won't
  // line up with any User row, so an invalid/expired token can never link to the
  // wrong account.
  const user = await db.user.findFirst({ where: { telegramLinkToken: token } });
  if (!user) {
    await reply(chatIdStr, "That link isn't valid. Open a fresh one from Settings → Notifications and try again.");
    return NextResponse.json({ ok: true });
  }

  // Link: set the chat id on this user and burn the single-use token.
  await db.user.update({
    where: { id: user.id },
    data: { telegramChatId: chatIdStr, telegramLinkToken: null },
  });

  await reply(
    chatIdStr,
    "✅ Your Telegram is now linked to SpaceWorker. You'll get notifications here once you enable the Telegram channel in Settings → Notifications.",
  );

  return NextResponse.json({ ok: true });
}

async function reply(chatId: string, text: string): Promise<void> {
  try {
    await sendTelegramMessage(chatId, text);
  } catch {
    // Best-effort — the webhook still acks Telegram regardless.
  }
}

// Telegram may probe the webhook URL; a GET is harmless but rejected.
export async function GET() {
  return NextResponse.json({ ok: true });
}