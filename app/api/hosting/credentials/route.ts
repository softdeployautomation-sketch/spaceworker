import { NextResponse } from "next/server";
import { z } from "zod";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import { createHostingCredential, listHostingCredentials } from "@/lib/hosting/credentials";

// TASK_155 P2 — GET  /api/hosting/credentials   (list the caller's, token-safe)
//                 POST /api/hosting/credentials   (add one)
//
// BYO Cloudflare (owner, 2026-10-01): a user stores their own account id + API
// token so a file can be hosted on their account instead of ours. The token is
// encrypted at rest and is NEVER in a response — the view carries only a 4-char
// hint. The first credential a user adds becomes their default automatically.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const credentials = await listHostingCredentials(user.id);
  return NextResponse.json({ credentials });
}

const postSchema = z.object({
  provider: z.string().max(40).optional(),
  accountId: z.string().min(1).max(200),
  label: z.string().min(1).max(80),
  token: z.string().min(1).max(400),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const decision = await hasEntitlement(user.id, "hosting");
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Hosting isn’t included on your account yet.", code: "not_entitled" },
      { status: 403 }
    );
  }

  let parsed;
  try {
    parsed = postSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const result = await createHostingCredential({
    userId: user.id,
    provider: parsed.provider,
    accountId: parsed.accountId,
    label: parsed.label,
    token: parsed.token,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  // Deliberately NOT returning the token — the view has no such field.
  return NextResponse.json({ credential: result.value }, { status: 201 });
}
