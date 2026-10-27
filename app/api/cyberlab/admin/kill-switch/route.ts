import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const KillSwitchSchema = z.object({
  scope: z.enum(["global", "tenant"]),
  targetId: z.string().optional(),
  frozen: z.boolean(),
  reason: z.string().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only admins can set kill switches
  if (user.tier < 5) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = KillSwitchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (parsed.data.scope === "tenant" && !parsed.data.targetId) {
    return NextResponse.json(
      { error: "targetId required for tenant scope" },
      { status: 400 },
    );
  }

  const existing = await db.cyberLabKillSwitch.findFirst({
    where: {
      scope: parsed.data.scope,
      targetId: parsed.data.targetId ?? null,
    },
  });

  if (existing) {
    await db.cyberLabKillSwitch.update({
      where: { id: existing.id },
      data: {
        frozen: parsed.data.frozen,
        reason: parsed.data.reason ?? null,
        setBy: user.id,
        setAt: new Date(),
      },
    });
  } else {
    await db.cyberLabKillSwitch.create({
      data: {
        scope: parsed.data.scope,
        targetId: parsed.data.targetId ?? null,
        frozen: parsed.data.frozen,
        reason: parsed.data.reason ?? null,
        setBy: user.id,
      },
    });
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const killSwitches = await db.cyberLabKillSwitch.findMany({
    orderBy: { setAt: "desc" },
  });

  return NextResponse.json({ killSwitches });
}