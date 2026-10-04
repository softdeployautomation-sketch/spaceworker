import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { getUserTicket } from "@/lib/support/tickets";

// TASK_159 Phase 1 — GET /api/support/tickets/<id>   (one ticket + its thread)
//
// THE 404-NOT-403 RULE (§4). Another user's ticket id must be INDISTINGUISHABLE from
// an id that does not exist. A 403 would confirm "this ticket exists, and it is not
// yours", which is a free enumeration oracle over other customers' support threads —
// and their subjects alone leak plenty.
//
// There is no branch in this file that can produce a 403, because ownership is a
// WHERE clause inside `getUserTicket`, not a comparison made here. A post-fetch check
// is the shape that gets dropped when somebody later adds a second caller.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16

  const result = await getUserTicket(user.id, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ticket: result.value });
}
