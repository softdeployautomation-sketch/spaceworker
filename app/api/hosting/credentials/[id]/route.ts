import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session-user";
import {
  deleteHostingCredential,
  updateHostingCredential,
  verifyHostingCredential,
} from "@/lib/hosting/credentials";

// TASK_155 P2 — PATCH  /api/hosting/credentials/<id>  (edit; token optional)
//                 DELETE /api/hosting/credentials/<id>  (revoke; promotes a new default)
//
// Editing without a `token` leaves the stored token untouched, so a user can fix
// a typo in the account id or the label without re-pasting the secret.

const patchSchema = z
  .object({
    accountId: z.string().min(1).max(200).optional(),
    label: z.string().min(1).max(80).optional(),
    token: z.string().min(1).max(400).optional(),
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

  const result = await updateHostingCredential({
    userId: user.id,
    id,
    accountId: parsed.accountId,
    label: parsed.label,
    token: parsed.token,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  // TASK_155 P3 — §16.4 verify-on-save: an edit (a new token, or a corrected
  // account id) re-confirms against Cloudflare and re-stamps the row. Like POST,
  // this never fails the save.
  const verified = await verifyHostingCredential(user.id, id).catch(() => null);
  return NextResponse.json({ credential: verified?.ok ? verified.value : result.value });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const result = await deleteHostingCredential(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ok: true, id: result.value.id });
}
