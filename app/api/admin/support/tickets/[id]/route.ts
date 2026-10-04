import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAdminSession } from "@/lib/admin-auth";
import { getAdminTicket, updateAdminTicket } from "@/lib/support/tickets";

// TASK_159 Phase 1 — GET   /api/admin/support/tickets/<id>   (one ticket, full thread)
//                    PATCH /api/admin/support/tickets/<id>   (resolve / reopen / reprioritise)
//
// The GET is an ADDITION to the plan's §4 table, which lists only PATCH for this path.
// It is required rather than convenient: the queue returns a one-line preview
// (`lastMessageAt` + count) and never the bodies, so without this an admin can see that
// a ticket exists and not what it says.
//
// No ownership filter here — an admin reads any ticket — and that is safe ONLY because
// of the `requireAdminSession()` gate at the top of every handler in this file. There
// is no path in this file that reaches the service without that check.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params; // MUST await — async in Next.js 16

  const result = await getAdminTicket(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ticket: result.value });
}

/**
 * PATCH semantics, stated once so the panel and this route cannot disagree:
 *
 *   field ABSENT (undefined)  -> leave it alone
 *   field present as null     -> clear it   (category / priority only)
 *   field present as a string -> set it
 *
 * That distinction is why every field is `.nullish()` rather than `.optional()`, and
 * is exactly the foot-gun the panel must respect: sending `{status:"resolved",
 * category:null}` does NOT mean "resolve and leave the category" — it means "resolve
 * and clear the category". The panel therefore sends only the fields it is changing.
 *
 * `status: null` is refused by the service (422) rather than treated as a clear: a
 * ticket always has a status, so an explicit null is a bug in the caller and should
 * say so loudly instead of silently persisting.
 */
const patchSchema = z.object({
  status: z.string().max(40).nullish(),
  category: z.string().max(40).nullish(),
  priority: z.string().max(20).nullish(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params; // MUST await — async in Next.js 16

  let parsed: z.infer<typeof patchSchema>;
  try {
    parsed = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const result = await updateAdminTicket(id, {
    status: parsed.status,
    category: parsed.category,
    priority: parsed.priority,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ ticket: result.value });
}
