import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { isSelfHosted } from "@/lib/exe-build-target";
import { readSetupState } from "@/lib/self-hosted-setup-state";

// POST /api/setup/telegram/test — body: { botToken }
//
// TASK_130 §2 step 5. The wizard's "test" for the Telegram notification
// channel. There is no pre-existing admin test-connection route for Telegram
// (checked: only app/api/admin/ai/route.ts has a live-fire test), so this
// reuses Telegram's own getMe — the lightest authenticated call that proves
// the bot token is real and reachable, with zero side effects (sendMessage
// would require a chat id the wizard doesn't have yet).
//
// Email/Resend needs no "test" route: RESEND_API_KEY is one of the four vars
// lib/env.ts requires at boot, so by the time a wizard page renders it's
// already a real, validated value — step 5 only reports whether it's set.
//
// Does not persist anything (final-confirm rule, TASK_130 §2 step 6).
export async function POST(req: Request) {
  if (!isSelfHosted()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const state = await readSetupState();
  if (state.completedAt && !(await getAdminSession())) {
    return NextResponse.json({ error: "Setup already completed" }, { status: 403 });
  }

  let body: { botToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
  if (!botToken) return NextResponse.json({ error: "Enter your Telegram bot token." }, { status: 400 });

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return NextResponse.json({
      ok: false,
      error: "Could not reach the Telegram API. Check this machine's internet connection.",
    });
  }

  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; description?: string; result?: { username?: string } }
    | null;

  if (!res.ok || !data?.ok) {
    return NextResponse.json({
      ok: false,
      error: data?.description
        ? `Telegram rejected the bot token: ${data.description}`
        : `Telegram rejected the bot token (HTTP ${res.status}).`,
    });
  }

  const username = data.result?.username;
  return NextResponse.json({ ok: true, ...(username ? { username } : {}) });
}
