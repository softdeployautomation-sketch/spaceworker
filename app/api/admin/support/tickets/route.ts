import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminSession, requireAdminSession } from "@/lib/admin-auth";
import { createAdminComposedTicket, listAdminTickets } from "@/lib/support/tickets";

// TASK_159 Phase 1 — GET /api/admin/support/tickets   (the queue)
// TASK_161 D4  — POST /api/admin/support/tickets  (file one ON A CUSTOMER'S BEHALF)
//
// Behind `requireAdminSession`, the same gate every other app/api/admin/** route uses.
// The protected page layout does NOT cover the sibling API tree, so each route has to
// call it itself.
//
// Filters come from the query string and are all optional. An ABSENT filter is passed
// through as null and IGNORED by the service — deliberately not defaulted to a value
// here, so the "what does the queue show by default" decision lives in one place
// instead of being split between this route and the panel.
//
// There is no per-user scoping here, by design: an admin reads every ticket. That is
// why this calls `listAdminTickets` rather than `listUserTickets` — the two are
// separate functions precisely so no route can reach the wrong one via a flag.

export async function GET(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const result = await listAdminTickets({
    status: url.searchParams.get("status"),
    category: url.searchParams.get("category"),
    priority: url.searchParams.get("priority"),
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ tickets: result.value });
}

/**
 * TASK_161 D4 — the admin-composed ticket.
 *
 * `userEmail` is the target, NOT a `userId`, and that is the whole design decision.
 * PLAN_TASK_159 §2.2 ("the owner comes from the session, never the body") governs the
 * CUSTOMER route, where the session names exactly one person. It cannot govern this one:
 * the admin session is a single shared passcode whose subject is the literal string
 * `"admin"` (see lib/admin-auth.ts) and carries no user identity to forward. So the
 * target is resolved SERVER-SIDE from the email, and the security intent is kept by
 * three things this route does in this order:
 *
 *   1. The admin gate runs BEFORE `request.json()` — an unauthenticated caller is
 *      rejected without the body ever being read, so this endpoint cannot be used to
 *      probe which email addresses have accounts.
 *   2. There is no id parameter to forge. An email must correspond to a real row.
 *   3. The customer-facing POST gains nothing: `/api/support/tickets` still cannot name
 *      a target user, so §2.2 is exactly as strong as it was.
 *
 * `domainRefId` is intentionally ABSENT. A ticket's domain must belong to the ticket's
 * owner (§3.3), and on the admin side there is no owner in the session to check against
 * — accepting one from a form would let staff attach any domain to any customer's
 * ticket. See `createAdminComposedTicket` for the full reasoning.
 */
const postSchema = z.object({
  userEmail: z.string().min(1).max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  category: z.string().max(40).nullish(),
  priority: z.string().max(20).nullish(),
});

export async function POST(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof postSchema>;
  try {
    parsed = postSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const session = await getAdminSession();
  const result = await createAdminComposedTicket({
    userEmail: parsed.userEmail,
    subject: parsed.subject,
    body: parsed.body,
    category: parsed.category ?? null,
    priority: parsed.priority ?? null,
    authorId: session?.sub ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ticket: result.value }, { status: 201 });
}
