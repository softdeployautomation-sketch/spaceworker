import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session-user";
import { deleteHostedFile, renameHostedFile } from "@/lib/hosting/files";

// TASK_155 P1 — PATCH  /api/hosting/files/<id>  (rename / re-label / re-scope)
//                 DELETE /api/hosting/files/<id>  (soft-delete + unlink bytes)
//
// PATCH touches ONLY the DB row (name, served filename, slug, visibility,
// expiry) — the stored bytes, sha256 and byte-count are never in the update, so
// "rename never touches the bytes" is structurally guaranteed (PLAN §4).

const patchSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    slug: z.string().max(63).nullable().optional(),
    visibility: z.enum(["public", "private"]).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
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

  const result = await renameHostedFile({
    userId: user.id,
    id,
    displayName: parsed.displayName,
    slug: parsed.slug,
    visibility: parsed.visibility,
    expiresAt: parsed.expiresAt === undefined ? undefined : parsed.expiresAt === null ? null : new Date(parsed.expiresAt),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ file: result.value });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const result = await deleteHostedFile(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}
