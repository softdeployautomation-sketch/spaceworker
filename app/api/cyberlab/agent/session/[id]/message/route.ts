import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { sendClineMessage } from "@/lib/lab/cline-agent";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MessageSchema = z.object({
  prompt: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = MessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await sendClineMessage(id, parsed.data.prompt, user.id);

    if (result.status === "failed") {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({
      sessionId: id,
      status: result.status,
      message: result.message,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "send_failed" },
      { status: 500 },
    );
  }
}