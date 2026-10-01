import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { setDefaultHostingCredential } from "@/lib/hosting/credentials";

// TASK_155 P2 — POST /api/hosting/credentials/<id>/default
//
// Switch which credential hosts (owner, 2026-10-01: "if users add multiple like
// 3, we should be able to switch between them for hosting"). Un-sets the previous
// default for the same provider in one transaction, so exactly one default holds.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16
  const result = await setDefaultHostingCredential(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ credential: result.value });
}
