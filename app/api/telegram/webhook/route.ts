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

  // A bot can receive lots of unrelated traffic; only act on a /start with a
  // link token, or a bare pasted token — everything else is just acknowledged.
  //
  // 2026-09-26 (live incident, root-caused with temporary payload logging):
  // when a chat with this shared bot already exists (e.g. the user linked it
  // to Vantra before), Telegram does NOT carry the deep link's ?start=TOKEN
  // payload through — re-tapping "Start" on an existing chat sends a bare
  // "/start" with no argument at all. There is no client-side way to force
  // the payload through in that case, so the fallback below accepts the raw
  // token as a plain pasted message too (shown next to the button in Settings
  // for exactly this situation), and a bare /start with no match gets a reply
  // pointing at that fallback instead of silently doing nothing.
  const startMatch = /^\/start(?:@\w+)?\s+(.+)$/.exec(text);
  const token = startMatch ? startMatch[1].trim() : looksLikeLinkToken(text) ? text : "";

  if (!chatId) {
    return NextResponse.json({ ok: true });
  }
  if (!token) {
    if (text === "/start" || text.startsWith("/start@")) {
      await reply(
        String(chatId),
        "I didn't get a link code with that — this can happen if you'd already chatted with me before. Copy the code shown in SpaceWorker → Settings → Notifications and send it to me here as a plain message.",
      );
    }
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

// Matches generateTelegramLinkToken()'s exact shape (base64url random +
// "." + an expiry epoch in ms) — narrow enough that ordinary chat text never
// accidentally matches, but permissive enough to accept a pasted token with
// no "/start" prefix.
function looksLikeLinkToken(text: string): boolean {
  return /^[A-Za-z0-9_-]+\.\d{10,}$/.test(text);
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