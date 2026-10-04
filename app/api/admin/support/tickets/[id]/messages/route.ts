import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminSession, requireAdminSession } from "@/lib/admin-auth";
import { addAdminMessage } from "@/lib/support/tickets";

// TASK_159 Phase 1 — POST /api/admin/support/tickets/<id>/messages   (admin reply)
//
// Append-only, same as the user side: no edit, no delete. The correction for a wrong
// message is another message (§2.3).
//
// Two calls to the auth layer on purpose:
//   * `requireAdminSession()` is the documented gate — the same call every other
//     app/api/admin/** route makes, so this route is indistinguishable in shape from
//     its neighbours and cannot be missed by a reviewer scanning for it.
//   * `getAdminSession()` is then read for its `sub`, which is the audit value stored
//     on the message.
// The admin session carries NO user id (it is a single shared passcode session whose
// subject is literally "admin"), so that string is the most specific identity that
// exists today. It goes in the nullable `authorId` column, which has no foreign key —
// so it can never block an admin's account removal (§3.2).

const messageSchema = z.object({ body: z.string().min(1).max(10_000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params; // MUST await — async in Next.js 16

  let parsed: z.infer<typeof messageSchema>;
  try {
    parsed = messageSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const session = await getAdminSession();
  const result = await addAdminMessage(id, parsed.body, session?.sub ?? null);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ message: result.value }, { status: 201 });
}
