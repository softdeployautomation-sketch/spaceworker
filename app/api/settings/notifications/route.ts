import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getCurrentUser } from "@/lib/session-user";
import { generateTelegramLinkToken } from "@/lib/telegram";

// PATCH /api/settings/notifications — update the user's per-channel notification
// preferences and/or manage their Telegram link. Follows the same shape as
// change-password/route.ts (getCurrentUser + zod).
//
// Body (all optional; at least one must be present):
//   notifyEmail / notifyTelegram / notifyAgent — boolean toggles (PATCH them all
//   at once is fine; omitted ones are left untouched).
//   unlink — true => clear telegramChatId (the user unlinks their chat).
//   regenerate — true => mint a fresh short-lived link token (used by the
//   settings UI's "Regenerate link" so a stale/compromised link is replaced).

const schema = z
  .object({
    notifyEmail: z.boolean().optional(),
    notifyTelegram: z.boolean().optional(),
    notifyAgent: z.boolean().optional(),
    // Task 94 — a SEPARATE toggle from notifyTelegram (see schema comment).
    telegramApprovalsEnabled: z.boolean().optional(),
    // 2026-09-26 — a THIRD, separate Telegram toggle: talk to the agent from
    // Telegram, not just tap-approve its pushes (see schema comment).
    telegramChatEnabled: z.boolean().optional(),
    digestEnabled: z.boolean().optional(),
    deviceTelemetryEnabled: z.boolean().optional(),
    agentActionsEnabled: z.boolean().optional(),
    unlink: z.boolean().optional(),
    regenerate: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.notifyEmail !== undefined ||
      v.notifyTelegram !== undefined ||
      v.notifyAgent !== undefined ||
      v.telegramApprovalsEnabled !== undefined ||
      v.telegramChatEnabled !== undefined ||
      v.digestEnabled !== undefined ||
      v.deviceTelemetryEnabled !== undefined ||
      v.agentActionsEnabled !== undefined ||
      v.unlink === true ||
      v.regenerate === true,
    "Nothing to update",
  );

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = schema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const data: Record<string, unknown> = {};

  // Preferences: only ever merge in the provided keys (never clobber others).
  if (parsed.notifyEmail !== undefined) data.notifyEmail = parsed.notifyEmail;
  if (parsed.notifyTelegram !== undefined) data.notifyTelegram = parsed.notifyTelegram;
  if (parsed.notifyAgent !== undefined) data.notifyAgent = parsed.notifyAgent;
  if (parsed.telegramApprovalsEnabled !== undefined) {
    data.telegramApprovalsEnabled = parsed.telegramApprovalsEnabled;
  }
  if (parsed.telegramChatEnabled !== undefined) {
    data.telegramChatEnabled = parsed.telegramChatEnabled;
  }
  // Task 92 — assistant foundation master toggles.
  if (parsed.digestEnabled !== undefined) data.digestEnabled = parsed.digestEnabled;
  if (parsed.deviceTelemetryEnabled !== undefined) {
    data.deviceTelemetryEnabled = parsed.deviceTelemetryEnabled;
  }
  // Master kill switch — "let the agent propose actions at all" (see schema
  // comment on User.agentActionsEnabled). Turning it off never touches chat
  // or manual device tools, only whether the agent may create a proposal.
  if (parsed.agentActionsEnabled !== undefined) {
    data.agentActionsEnabled = parsed.agentActionsEnabled;
  }

  if (parsed.unlink === true) {
    // Unlinking clears the chat id (and the now-stale link token). notifyUser
    // already skips telegram when telegramChatId is null regardless of the flag,
    // so this is the single source of truth for "not linked".
    data.telegramChatId = null;
    data.telegramLinkToken = null;
    // Task 94 — meaningless without a linked chat (notifyPendingActionViaTelegram
    // already checks telegramChatId too, but reset it so Settings doesn't show
    // "on" for a toggle that can't fire anything).
    data.telegramApprovalsEnabled = false;
    data.telegramChatEnabled = false;
  }

  if (parsed.regenerate === true) {
    // Mint a fresh token for a new Connect deep link. The webhook only matches a
    // token once, so an attacker who grabbed the old URL can't replay it.
    data.telegramLinkToken = generateTelegramLinkToken();
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: {
      notifyEmail: true,
      notifyTelegram: true,
      notifyAgent: true,
      telegramApprovalsEnabled: true,
      telegramChatEnabled: true,
      digestEnabled: true,
      deviceTelemetryEnabled: true,
      agentActionsEnabled: true,
      telegramChatId: true,
      telegramLinkToken: true,
    },
  });

  const linked = updated.telegramChatId !== null;
  // Fresh Connect deep link (present only when unlinked AND a bot username is
  // configured; null otherwise so the UI can tell "unlinked, linkable" from
  // "Telegram not configured").
  const connectUrl =
    !linked && updated.telegramLinkToken && env.telegramBotUsername
      ? `https://t.me/${env.telegramBotUsername}?start=${updated.telegramLinkToken}`
      : null;
  // 2026-09-26 (live incident) — see schema/webhook comments: Telegram drops
  // the ?start= payload when a chat with this bot already exists, so the UI
  // also offers the raw token to paste directly as a fallback.
  const linkToken = !linked ? updated.telegramLinkToken : null;

  return NextResponse.json({
    ok: true,
    prefs: {
      notifyEmail: updated.notifyEmail,
      notifyTelegram: updated.notifyTelegram,
      notifyAgent: updated.notifyAgent,
      telegramApprovalsEnabled: updated.telegramApprovalsEnabled,
      telegramChatEnabled: updated.telegramChatEnabled,
      digestEnabled: updated.digestEnabled,
      deviceTelemetryEnabled: updated.deviceTelemetryEnabled,
      agentActionsEnabled: updated.agentActionsEnabled,
      linked,
      connectUrl,
      linkToken,
    },
  });
}