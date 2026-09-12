import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { resolveSystemTemplatesOwnerId } from "@/lib/campaign-templates";

// Task 28, item 5 — list the system-owned "ready-made" campaign templates for
// the Automations builder's template picker. Surfaces ONLY the system account's
// EmailCampaign rows (never other users'), and returns an empty list when no
// ready-made-template account is configured, so the builder degrades gracefully
// to just "my campaigns".
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ownerId = await resolveSystemTemplatesOwnerId();
  if (!ownerId) return NextResponse.json([]);

  const templates = await prisma.emailCampaign.findMany({
    where: { userId: ownerId },
    include: { variants: { select: { id: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { name: "asc" },
  });

  return NextResponse.json(
    templates.map((c) => ({ id: c.id, name: c.name, variants: c.variants })),
  );
}