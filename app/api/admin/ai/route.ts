import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import {
  ChannelryAiError,
  channelryAiChat,
  channelryAiConfigured,
} from "@/lib/channelry-ai";

// /api/admin/ai — SpaceWorker's admin-side mirror of the Channelry connection
// check. GET reports whether the key is configured (a boolean, never the raw
// value); POST fires a trivial real plain-completion against the live Channelry
// endpoint and returns the actual usage block (the same bar Channelry's own
// live-fire test used: cost_hundredths_cent >= 1).

export async function GET() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ configured: channelryAiConfigured() });
}

export async function POST() {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (!channelryAiConfigured()) {
    return NextResponse.json(
      { error: "Not configured", code: "unconfigured" },
      { status: 503 }
    );
  }

  try {
    const result = await channelryAiChat({
      // Trivial plain-completion test per the task spec. Ties the cost
      // attribution to an internal admin id, not a real user.
      system: "Reply with exactly one word.",
      user: "test",
      max_tokens: 16,
      temperature: 0,
      external_user_id: "__admin_connection_test__",
    });
    return NextResponse.json({
      ok: true,
      content: result.content,
      usage: result.usage,
    });
  } catch (err) {
    if (err instanceof ChannelryAiError) {
      return NextResponse.json(
        {
          ok: false,
          error: err.message,
          code: err.code,
          statusCode: err.status || undefined,
        },
        { status: err.status === 0 ? 503 : (err.status >= 400 ? err.status : 502) }
      );
    }
    return NextResponse.json(
      { ok: false, error: "Unexpected error", code: "bad_request" },
      { status: 500 }
    );
  }
}