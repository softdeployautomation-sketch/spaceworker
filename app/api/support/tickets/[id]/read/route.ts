import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { markTicketRead } from "@/lib/support/tickets";

// TASK_166 — POST /api/support/tickets/<id>/read
//
// Clears the unread badge on the support button (owner, 2026-10-05: an admin reply
// "delivered into the user, but it didn't show like a notification on the support
// button").
//
// This is a POST and not a GET/PUT on the ticket because it WRITES the owner's read
// cursor. It is deliberately narrow: it accepts no body, changes no ticket content, and
// can only ever move the cursor FORWARD, for the caller's OWN ticket.
//
// It lives in its own `/read` directory rather than as a second handler in
// `[id]/route.ts` because a Next.js route module exports exactly one handler per method,
// and `[id]/messages` already owns POST for this ticket id. Same reason there is no
// DELETE anywhere in this feature (§2.3): a route that does not exist cannot be called.
//
// The owner comes from the SESSION and the id from the PATH, never the reverse —
// `markTicketRead(user.id, id)` filters on that pair and answers 404 rather than 403 for
// somebody else's ticket, so this is not an existence oracle over other customers'
// support threads.
//
// Marking read twice is a no-op, so a client retry cannot corrupt anything.

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16

  const result = await markTicketRead(user.id, id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, id: result.value.id, lastReadAt: result.value.lastReadAt });
}