import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { heartbeat, PRESENCE_PAGE_MAX_CHARS } from "@/lib/user-presence";

// POST /api/presence — TASK_190 S5, the customer-side heartbeat target.
//
// Body: `{ page?: string, active?: boolean }` — `page` is the beacon's
// current pathname (truncated to PRESENCE_PAGE_MAX_CHARS), `active` says the
// beacon saw real input (pointer/keys/scroll) since the previous ping; when
// false the lib skips lastActiveAt so an idle-but-open tab reads as idle
// (verify §4.2) and the ping writes exactly two User columns (verify §4.5).
// 401 without a session (verify §4.5) — this route never exists for the EXE
// runtime: getCurrentUser is a session-cookie DB read, called only from the
// hosted dashboard branch that mounts the beacon.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { page?: unknown; active?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // Empty/garbage body is a plain ping — treat as pageless, inactive.
  }
  const page = typeof body.page === "string" && body.page ? body.page.slice(0, PRESENCE_PAGE_MAX_CHARS) : null;

  const result = await heartbeat(user.id, page, new Date(), { active: body.active === true });
  return NextResponse.json({ ok: true, state: result.state });
}
