import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminSession, requireAdminSession } from "@/lib/admin-auth";
import { notifyUserTicketReply } from "@/lib/support-notify";
import { broadcastAdminMessage, BROADCAST_AUDIENCES } from "@/lib/support/tickets";

// TASK_199 — POST /api/admin/support/broadcast — the admin panel's "message
// everyone (or one tier)" composer. Same two-call auth shape as the sibling
// admin message route: `requireAdminSession()` is the documented gate,
// `getAdminSession()` then reads `sub` for the authorId stamped on each
// message. `.strict()` so a typo'd key is REFUSED, never silently ignored —
// an audience the admin thinks they selected but didn't is how the wrong
// thousand people get emailed.
const broadcastSchema = z
  .object({
    audience: z.enum(BROADCAST_AUDIENCES),
    // .trim() BEFORE .min(1) so a whitespace-only body is a 400 here rather
    // than N per-user failures reported as a 200 (zod checks run in order).
    body: z.string().trim().min(1).max(5000),
  })
  .strict();

export async function POST(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsed: z.infer<typeof broadcastSchema>;
  try {
    parsed = broadcastSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const session = await getAdminSession();
  const counts = await broadcastAdminMessage({
    audience: parsed.audience,
    body: parsed.body,
    adminId: session?.sub ?? null,
    // TASK_187 S2 — a support message emails the user; support-notify skips a
    // non-email recipient itself and never throws into this route.
    notify: notifyUserTicketReply,
  });

  // COUNTS ONLY — user ids and emails never leave this route (the panel shows
  // "sent to N, failed M" and nothing about who).
  return NextResponse.json(counts);
}
