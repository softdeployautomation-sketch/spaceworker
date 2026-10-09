import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminSession } from "@/lib/admin-auth";
import { getAdminNotifyPrefs, setAdminNotifyPrefs } from "@/lib/admin-notify";

export const dynamic = "force-dynamic";

// TASK_190 S3 — GET/PATCH /api/admin/notification-prefs
//
//   GET   → the SAFE prefs view: the two channel switches, whether Telegram is
//           linked (boolean only — the chat id is WRITE-ONLY and never leaves
//           lib/admin-notify), plus `configured` (env reality, so the header
//           greys a toggle out for a channel that cannot send) and the
//           VERIFY-shaped `prefs`/`configured` nest for the live checklist.
//   PATCH → {telegramEnabled?, emailEnabled?, telegramChatId?} persisted to
//           the singleton AdminNotificationPref row via setAdminNotifyPrefs
//           (the lib validates the chat id as a numeric string and builds the
//           upsert from the passed keys alone); responds with the same SAFE
//           view as GET so the caller can never read the chat id back.
//
// Auth: 401 Unauthorized without a valid admin session — the precedent for
// this answer in the admin tree is app/api/admin/support/tickets (the
// PROMPT_VERIFY §2.5 contract pins 401 for this route).

const patchSchema = z
  .object({
    telegramEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    telegramChatId: z.string().regex(/^-?\d+$/, "chat id must be numeric").nullable().optional(),
  })
  .refine(
    (v) =>
      v.telegramEnabled !== undefined || v.emailEnabled !== undefined || v.telegramChatId !== undefined,
    { message: "Nothing to update" },
  );

/** The response body both handlers share — structurally incapable of leaking the chat id. */
async function safeView() {
  const view = await getAdminNotifyPrefs();
  return {
    ok: true,
    // Flat trio (PROMPT_CONTINUE contract).
    telegramEnabled: view.telegramEnabled,
    emailEnabled: view.emailEnabled,
    telegramLinked: view.telegramLinked,
    // Nested shape (PROMPT_VERIFY §2.2 contract).
    prefs: {
      notifyEmail: view.emailEnabled,
      notifyTelegram: view.telegramEnabled,
      telegramLinked: view.telegramLinked,
    },
    configured: view.configured,
  };
}

export async function GET() {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await safeView());
}

export async function PATCH(req: Request) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: first?.message ?? "Invalid body." }, { status: 400 });
  }

  try {
    await setAdminNotifyPrefs(parsed.data);
  } catch (err) {
    // The lib throws only on an invalid chat id — surface its clear text.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save preferences." },
      { status: 400 },
    );
  }

  return NextResponse.json(await safeView());
}
