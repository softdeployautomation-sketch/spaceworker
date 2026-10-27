import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { stopClineSession } from "@/lib/lab/cline-agent";

export const dynamic = "force-dynamic";

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

  try {
    const result = await stopClineSession(id, user.id);

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 404 });
    }

    return NextResponse.json({ ok: true, sessionId: id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "stop_failed" },
      { status: 500 },
    );
  }
}