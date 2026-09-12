import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { resolveSystemTemplatesOwnerId } from "@/lib/campaign-templates";

// Task 28, item 5 — update / delete a single ready-made campaign template.
// Only the system account's own EmailCampaign rows can be edited here (the same
// ownership boundary as every other row in the app); a template that's already
// referenced by automations becomes a dangling reference on delete, exactly like
// deleting a user's own campaign today (a subsequent run fails gracefully).

function sanitizeVariants(value: unknown): { subject: string; bodyHtml: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { subject: string; bodyHtml: string }[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "object" || v === null) continue;
    const o = v as { subject?: unknown; bodyHtml?: unknown };
    const subject = typeof o.subject === "string" ? o.subject.trim() : "";
    const bodyHtml = typeof o.bodyHtml === "string" ? o.bodyHtml.trim() : "";
    const key = `${subject}\u0000${bodyHtml}`;
    if (subject.length > 0 && bodyHtml.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push({ subject, bodyHtml });
    }
  }
  return out;
}

async function getOwnedTemplateId(params: Promise<{ id: string }>) {
  const { id } = await params;
  const ownerId = await resolveSystemTemplatesOwnerId();
  if (!ownerId) return null;
  const row = await prisma.emailCampaign.findFirst({
    where: { id, userId: ownerId },
    select: { id: true },
  });
  return row?.id ?? null;
}

// PATCH /api/admin/campaign-templates/[id]  body: { name?, variants? }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const ownedId = await getOwnedTemplateId(params);
  if (!ownedId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { name?: unknown; variants?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : null;
  const variants = body.variants !== undefined ? sanitizeVariants(body.variants) : null;
  if (variants !== null && variants.length === 0) {
    return NextResponse.json(
      { error: "At least one subject/body variant is required" },
      { status: 400 },
    );
  }

  await prisma.$transaction(async (tx) => {
    if (variants !== null) {
      // Replace the variant set atomically so no partial variant mix can persist.
      await tx.campaignVariant.deleteMany({ where: { campaignId: ownedId } });
      await tx.campaignVariant.createMany({
        data: variants.map((v) => ({ campaignId: ownedId, subject: v.subject, bodyHtml: v.bodyHtml })),
      });
    }
  });

  // Separate from the variant swap: renaming is optional, and Prisma rejects an
  // empty `data` object, so skip the update entirely when no name change came in.
  if (name !== null) {
    await prisma.emailCampaign.update({ where: { id: ownedId }, data: { name } });
  }

  const updated = await prisma.emailCampaign.findUnique({
    where: { id: ownedId },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { id: true, subject: true, bodyHtml: true } } },
  });

  return NextResponse.json(updated);
}

// DELETE /api/admin/campaign-templates/[id]
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const ownedId = await getOwnedTemplateId(params);
  if (!ownedId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.$transaction([
    prisma.campaignVariant.deleteMany({ where: { campaignId: ownedId } }),
    prisma.emailCampaign.delete({ where: { id: ownedId } }),
  ]);

  return NextResponse.json({ ok: true });
}