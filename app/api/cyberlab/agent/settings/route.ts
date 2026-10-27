import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const SettingsSchema = z.object({
  clineApiKey: z.string().min(1).optional(),
  clineModelId: z.string().optional(),
  clineApiEndpoint: z.string().url().optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const settings = await db.cyberLabAgentSettings.findUnique({
    where: { userId: user.id },
    select: {
      clineModelId: true,
      clineApiEndpoint: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    settings: settings ?? null,
  });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = SettingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  await db.cyberLabAgentSettings.upsert({
    where: { userId: user.id },
    update: {
      clineApiKeyEnc: parsed.data.clineApiKey ?? undefined,
      clineModelId: parsed.data.clineModelId ?? undefined,
      clineApiEndpoint: parsed.data.clineApiEndpoint ?? undefined,
    },
    create: {
      userId: user.id,
      clineApiKeyEnc: parsed.data.clineApiKey ?? undefined,
      clineModelId: parsed.data.clineModelId ?? undefined,
      clineApiEndpoint: parsed.data.clineApiEndpoint ?? undefined,
    },
  });

  return NextResponse.json({ ok: true });
}