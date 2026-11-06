import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { moduleToolsDenied } from "@/lib/module-gate";
import { startClineLabSession, listClineSessions } from "@/lib/lab/cline-agent";
import { z } from "zod";

export const dynamic = "force-dynamic";

const StartSessionSchema = z.object({
  prompt: z.string().min(1),
  modelId: z.string().optional(),
  apiEndpoint: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  targets: z.array(z.object({
    kind: z.string().min(1),
    value: z.string().min(1),
  })).optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  const sessions = await listClineSessions(user.id);
  return NextResponse.json({ sessions });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const denied = await moduleToolsDenied(user.id, "cyberlab");
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = StartSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await startClineLabSession({
      userId: user.id,
      prompt: parsed.data.prompt,
      modelId: parsed.data.modelId,
      apiEndpoint: parsed.data.apiEndpoint,
      apiKey: parsed.data.apiKey,
      targets: parsed.data.targets,
    });

    if (result.status === "failed") {
      return NextResponse.json(
        { error: result.message, sessionId: result.sessionId },
        { status: 400 },
      );
    }

    return NextResponse.json({
      sessionId: result.sessionId,
      status: result.status,
      message: result.message,
      approvalRequest: result.approvalRequest ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "start_failed" },
      { status: 500 },
    );
  }
}