import { NextResponse } from "next/server";
import { z } from "zod";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import { createHostedLink, listHostedLinks } from "@/lib/hosting/links";

// TASK_155 P2 — GET  /api/hosting/links   (list the caller's own short links)
//                 POST /api/hosting/links   (mint one)
//
// A user-owned redirect: /r/<slug|token> → the target they chose. The row lives
// in LinkRedirect (the Task 30 table) with userId set; every campaign link keeps
// userId NULL and is neither listed nor counted here.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const links = await listHostedLinks(user.id);
  return NextResponse.json({ links });
}

const postSchema = z.object({
  target: z.string().min(1).max(2048),
  label: z.string().max(200).nullable().optional(),
  slug: z.string().max(63).nullable().optional(),
  // TASK_155 P6c — "local" (free) or "cloudflare" (premium Worker). Anything else
  // is coerced to local by the engine, so a junk value cannot reach Cloudflare.
  engine: z.enum(["local", "cloudflare"]).optional(),
  customHost: z.string().max(253).nullable().optional(),
  credentialId: z.string().max(64).nullable().optional(),
  // TASK_175 — Desktop-only gate (premium-only). Accepted from anyone, but
  // lib/hosting/links.ts silently drops `true` for non-premium minters, so a
  // forged body from a free account mints a normal link.
  desktopOnly: z.boolean().optional(),
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

  const result = await createHostedLink({
    userId: user.id,
    target: parsed.target,
    label: parsed.label,
    slug: parsed.slug,
    engine: parsed.engine,
    customHost: parsed.customHost,
    credentialId: parsed.credentialId,
    desktopOnly: parsed.desktopOnly,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ link: result.value }, { status: 201 });
}
