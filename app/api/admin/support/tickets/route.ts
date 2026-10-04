import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { listAdminTickets } from "@/lib/support/tickets";

// TASK_159 Phase 1 — GET /api/admin/support/tickets   (the queue)
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
