import { NextResponse } from "next/server";

import { getSession } from "@/lib/session";
import { deleteInstallLink } from "@/lib/vantra-link";

export const dynamic = "force-dynamic";

// TASK_224 — DELETE /api/assistant/vantra/install-link/<id>: remove ONE public
// mint-history row from the user's "All links" list. Ownership (404, scoped to
// the caller — never "forbidden", no existence oracle) and the CURRENT-link
// protection (409 `current_link`, owner rule 2026-10-19) live in
// lib/vantra-link.ts's `deleteInstallLink` — the same code the tests drive —
// so this route is only session + status mapping:
//   401 no session · 404 not the caller's row · 409 current_link.
// Deletion is local-only: no Vantra call, no pointer change, no expiry branch.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16
  try {
    const result = await deleteInstallLink(session.userId, id);
    return NextResponse.json(result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "delete_failed";
    const status = code === "not_found" ? 404 : code === "current_link" ? 409 : 500;
    return NextResponse.json({ error: code }, { status });
  }
}