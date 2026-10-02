import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { verifyHostingCredential } from "@/lib/hosting/credentials";

// TASK_155 P3 — POST /api/hosting/credentials/<id>/verify.
//
// The §16.4 re-verify: confirm a stored token still works and re-stamp the row.
// Always 200 for an owned credential (a dead token is a RED row, not an error), so
// the chooser can refresh its "verified …" stamp in place.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16
  const result = await verifyHostingCredential(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ credential: result.value });
}