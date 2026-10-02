import { NextResponse } from "next/server";
import { z } from "zod";

import { hasEntitlement } from "@/lib/entitlements";
import { getCurrentUser } from "@/lib/session-user";
import { createSite, listSites } from "@/lib/hosting/sites";
import { listHostingCredentials } from "@/lib/hosting/credentials";

// TASK_155 P3 — GET  /api/hosting/sites   (list the caller's sites)
//                 POST /api/hosting/sites   (create one)
//
// A site is the container for the folder→preview→publish flow. Its ENGINE is
// chosen here, per item (§16.2), and is bound for the site's life. A premium
// ("cloudflare") site may name one of the caller's own credentials — otherwise the
// deploy resolves the caller's default, then the platform account (§16.4).
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sites = await listSites(user.id);
  return NextResponse.json({ sites });
}

const postSchema = z.object({
  name: z.string().min(1).max(120),
  engine: z.enum(["local", "cloudflare"]).optional(),
  credentialId: z.string().max(200).optional().nullable(),
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

  // A named credential must belong to the caller (never a foreign account).
  if (parsed.credentialId) {
    const owned = await listHostingCredentials(user.id);
    if (!owned.some((c) => c.id === parsed.credentialId)) {
      return NextResponse.json({ error: "That account isn’t on your list.", code: "bad_credential" }, { status: 400 });
    }
  }

  const result = await createSite({
    userId: user.id,
    name: parsed.name,
    engine: parsed.engine,
    credentialId: parsed.credentialId ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ site: result.value }, { status: 201 });
}
