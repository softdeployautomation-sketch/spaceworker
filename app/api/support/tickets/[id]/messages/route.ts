import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/session-user";
import { addUserMessage } from "@/lib/support/tickets";

// TASK_159 Phase 1 — POST /api/support/tickets/<id>/messages   (user reply)
//
// Append-only (§2.3): there is no PUT, no PATCH and no DELETE on a message anywhere in
// this feature. Support history that can be rewritten is not history, so a correction
// is a new message. The absence of those handlers IS the enforcement — a route that
// does not exist cannot be called.
//
// Ownership and the 404-not-403 rule are the same as the GET: `addUserMessage` takes
// the session user id first and filters on it.

const messageSchema = z.object({ body: z.string().min(1).max(10_000) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params; // MUST await — async in Next.js 16

  let parsed: z.infer<typeof messageSchema>;
  try {
    parsed = messageSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const result = await addUserMessage(user.id, id, parsed.body);
  if (!result.ok) {
    return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
  }
  return NextResponse.json({ message: result.value }, { status: 201 });
}
