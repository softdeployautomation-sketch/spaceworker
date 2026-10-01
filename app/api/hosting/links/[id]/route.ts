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
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ link: result.value });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const result = await deleteHostedLink(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}
