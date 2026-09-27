import { NextResponse } from "next/server";

import { AiProviderError, aiProviderChat } from "@/lib/ai-provider";
import { getAdminSession } from "@/lib/admin-auth";
import { isSelfHosted } from "@/lib/exe-build-target";
import { readSetupState } from "@/lib/self-hosted-setup-state";

// POST /api/setup/ai-provider/test — body: { apiKey, baseUrl?, model? }
//
// TASK_130 §3. Fires a trivial completion through the SUBMITTED credentials
// (via the TASK_130 override on aiProviderChat) — env.aiProviderApiKey is
// still blank at this point, the value hasn't been written yet. Reports the
// mapped AiProviderError.code/message on failure, mirroring
// app/api/admin/ai/route.ts's response shape (minus the pooled-usage block,
// which doesn't apply to a BYO key).
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

  let body: { apiKey?: unknown; baseUrl?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ error: "Enter your AI provider API key." }, { status: 400 });
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
  const model = typeof body?.model === "string" ? body.model.trim() : "";

  try {
    const result = await aiProviderChat(
      {
        system: "Reply with exactly one word.",
        user: "Say OK.",
        max_tokens: 5,
        temperature: 0,
        external_user_id: "setup-wizard-test",
      },
      {
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
      },
    );
    return NextResponse.json({ ok: true, content: result.content });
  } catch (err) {
    if (err instanceof AiProviderError) {
      return NextResponse.json({ ok: false, error: err.message, code: err.code });
    }
    return NextResponse.json({
      ok: false,
      error: "The AI provider test failed unexpectedly. Check the key and base URL.",
    });
  }
}
