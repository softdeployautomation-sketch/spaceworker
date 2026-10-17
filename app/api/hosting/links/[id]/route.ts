import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session-user";
import { deleteHostedLink, updateHostedLink } from "@/lib/hosting/links";

// TASK_155 P2 — PATCH  /api/hosting/links/<id>  (re-target / re-label / re-slug)
//                 DELETE /api/hosting/links/<id>  (remove the user's own link)
//
// Both operate ONLY on rows whose userId is the caller's, so a campaign link
// (userId NULL) can never be edited or deleted through this route.

const patchSchema = z
  .object({
    target: z.string().min(1).max(2048).optional(),
    label: z.string().max(200).nullable().optional(),
    slug: z.string().max(63).nullable().optional(),
    // TASK_155 P6c — switching engines re-runs the premium gate server-side.
    engine: z.enum(["local", "cloudflare"]).optional(),
    customHost: z.string().max(253).nullable().optional(),
    credentialId: z.string().max(64).nullable().optional(),
    // TASK_175 — Desktop-only gate. `true` sets it (premium-only, silently
    // dropped for anyone else), `false` clears it for any owner.
    desktopOnly: z.boolean().optional(),
    // TASK_205 — editable interstitial copy + platform-split mobile target.
    // Empty string or null CLEARS back to default for any owner; a non-empty
    // value is set premium-only (server drops it for non-premium). The mobile
    // value is URL-validated server-side, so we don't constrain it here.
    desktopTitle: z.string().max(200).nullable().optional(),
    desktopBody: z.string().max(500).nullable().optional(),
    mobileTarget: z.string().max(2048).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

import { moduleToolsDenied } from "@/lib/module-gate";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "hosting");
  if (denied) return denied;

  const { id } = await params; // MUST await — async in Next.js 16

  let parsed;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.errors[0]?.message : "Invalid request body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const result = await updateHostedLink({
    userId: user.id,
    id,
    target: parsed.target,
    label: parsed.label,
    slug: parsed.slug,
    engine: parsed.engine,
    customHost: parsed.customHost,
    credentialId: parsed.credentialId,
    desktopOnly: parsed.desktopOnly,
    // TASK_205 — pass the editable wording + split target straight through; the
    // server owns the premium-drop and URL-validation rules.
    desktopTitle: parsed.desktopTitle,
    desktopBody: parsed.desktopBody,
    mobileTarget: parsed.mobileTarget,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ link: result.value });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await moduleToolsDenied(user.id, "hosting");
  if (denied) return denied;

  const { id } = await params;
  const result = await deleteHostedLink(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}
