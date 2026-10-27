import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { resolveToolApproval } from "@/lib/lab/cline-agent";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ApproveSchema = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
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

  const parsed = ApproveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  resolveToolApproval(id, parsed.data.approved, parsed.data.reason);

  return NextResponse.json({
    ok: true,
    sessionId: id,
    approved: parsed.data.approved,
  });
}