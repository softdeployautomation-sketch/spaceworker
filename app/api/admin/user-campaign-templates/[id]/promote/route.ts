import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { ensureSystemTemplatesOwner } from "@/lib/campaign-templates";

// POST /api/admin/user-campaign-templates/[id]/promote
// Clones a user-saved template's subject/body variants into a NEW EmailCampaign
// owned by the system templates account — i.e. it joins the exact same
// "Ready-made templates" group /api/admin/campaign-templates authors directly.
// The user's own row is never modified except to stamp promotedTemplateId,
// which makes this idempotent: a second call just returns the existing clone
// instead of creating a duplicate general template.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;

  const source = await prisma.emailCampaign.findFirst({
    where: { id, savedAsTemplate: true },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { subject: true, bodyHtml: true } } },
  });
  if (!source) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (source.promotedTemplateId) {
    return NextResponse.json({ ok: true, alreadyPromoted: true, templateId: source.promotedTemplateId });
  }
  if (source.variants.length === 0) {
    return NextResponse.json({ error: "That campaign has no subject/body content to promote" }, { status: 400 });
  }

  const ownerId = await ensureSystemTemplatesOwner();

  const created = await prisma.$transaction(async (tx) => {
    const campaign = await tx.emailCampaign.create({
      data: {
        userId: ownerId,
        name: source.name,
        subject: "",
        bodyHtml: "",
        status: "draft", // never sendable directly — only ever cloned, same as an admin-authored template
        mailboxIds: [],
        rotateEvery: 1,
      },
      select: { id: true },
    });
    await tx.campaignVariant.createMany({
      data: source.variants.map((v) => ({ campaignId: campaign.id, subject: v.subject, bodyHtml: v.bodyHtml })),
    });
    return campaign;
  });

  await prisma.emailCampaign.update({
    where: { id: source.id },
    data: { promotedTemplateId: created.id },
  });

  return NextResponse.json({ ok: true, templateId: created.id });
}
