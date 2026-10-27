import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { resumeClineSession } from "@/lib/lab/cline-agent";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ResumeSessionSchema = z.object({
  prompt: z.string().min(1),
});

export async function POST(
  _req: Request,
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
    body = await _req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ResumeSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await resumeClineSession(id, user.id, parsed.data.prompt);

    if (result.status === "failed") {
      return NextResponse.json(
        { error: result.message, sessionId: id },
        { status: 400 },
      );
    }

    return NextResponse.json({
      sessionId: id,
      status: result.status,
      message: result.message,
      approvalRequest: result.approvalRequest ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "resume_failed" },
      { status: 500 },
    );
  }
}
