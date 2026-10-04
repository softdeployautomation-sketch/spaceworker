import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session-user";
import { createSupportTicket, listUserTickets } from "@/lib/support/tickets";

// TASK_159 Phase 1 — GET  /api/support/tickets   (the caller's OWN tickets)
//                    POST /api/support/tickets   (open one)
//
// Scope: PLAN_TASK_159_SUPPORT_TICKETS.md §4. This is the only place a user's ticket
// list can be produced, and it calls `listUserTickets(user.id)`, which filters on the
// session's user id. There is deliberately no "list all" query parameter here: a user
// asking for `?scope=all` gets their own tickets, because the parameter does not exist.
//
// The caller's id ALWAYS comes from the session, never from the body — otherwise a
// crafted POST files a ticket against somebody else's account (§2.2).

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await listUserTickets(user.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ tickets: result.value });
}

/**
 * Constraints here mirror `lib/support/tickets.ts` and exist so a malformed request is
 * rejected as a 400 before any work happens. They are NOT the credential check: that
 * lives in the service, on the trimmed values actually being stored, so it applies to
 * every caller and not just this route.
 *
 * `domainRefId` is an ID, never an apex. The service resolves it against the caller's
 * own domains and answers 404 for anything else (§3.3).
 */
const postSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  category: z.string().max(40).nullish(),
  priority: z.string().max(20).nullish(),
  domainRefId: z.string().max(64).nullish(),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let parsed: z.infer<typeof postSchema>;
  try {
    parsed = postSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const result = await createSupportTicket({
    // From the SESSION. `parsed` has no userId field to accidentally trust.
    userId: user.id,
    subject: parsed.subject,
    body: parsed.body,
    category: parsed.category ?? null,
    priority: parsed.priority ?? null,
    domainRefId: parsed.domainRefId ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ticket: result.value }, { status: 201 });
}
