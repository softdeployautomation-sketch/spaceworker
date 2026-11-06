import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { getClineSessionMessages } from "@/lib/lab/cline-agent";

export const dynamic = "force-dynamic";

export async function GET(
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

  const transcript = await getClineSessionMessages(id, user.id);
  if (!transcript) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(transcript);
}
