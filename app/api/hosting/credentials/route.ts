import { NextResponse } from "next/server";
import { z } from "zod";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import {
  countSitesByCredential,
  createHostingCredential,
  listHostingCredentials,
  verifyHostingCredential,
} from "@/lib/hosting/credentials";

// TASK_155 P2 — GET  /api/hosting/credentials   (list the caller's, token-safe)
//                 POST /api/hosting/credentials   (add one)
//
// BYO Cloudflare (owner, 2026-10-01): a user stores their own account id + API
// token so a file can be hosted on their account instead of ours. The token is
// encrypted at rest and is NEVER in a response — the view carries only a 4-char
// hint. The first credential a user adds becomes their default automatically.
//
// TASK_155 P3 — the §16.4 chooser fields: every row now carries a `projectCount`
// (how many sites are bound to it) and the `lastVerifiedAt`/`verifyError` stamp,
// and a POST verifies the token on save (§16.4 "verify on save").
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [credentials, counts] = await Promise.all([
    listHostingCredentials(user.id),
    countSitesByCredential(user.id),
  ]);
  return NextResponse.json({
    credentials: credentials.map((c) => ({ ...c, projectCount: counts[c.id] ?? 0 })),
  });
}

const postSchema = z.object({
  provider: z.string().max(40).optional(),
  accountId: z.string().min(1).max(200),
  label: z.string().min(1).max(80),
  token: z.string().min(1).max(400),
  /**
   * TASK_155 P6c — the optional Workers/DNS token (`Workers Scripts:Edit` +
   * `DNS:Edit`) so this account can also serve LINK redirects. Omitted = Pages
   * only, which is the pre-P6c behaviour.
   */
  workerToken: z.string().min(1).max(500).optional(),
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
    workerToken: parsed.workerToken,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  // TASK_155 P3 — §16.4 verify-on-save. The token is confirmed against Cloudflare
  // (`/user/tokens/verify` + a cheap Pages read) and the outcome is stamped on the
  // row. This NEVER fails the save — a user may add an account while offline — it
  // only marks the row red, and the engine then fails CLOSED on a red row.
  const verified = await verifyHostingCredential(user.id, result.value.id).catch(() => null);
  const credential = verified?.ok ? verified.value : result.value;
  // Deliberately NOT returning the token — the view has no such field.
  return NextResponse.json({ credential }, { status: 201 });
}
