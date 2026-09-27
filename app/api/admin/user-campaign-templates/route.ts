import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

// User-submitted campaign templates — any EmailCampaign a user has flagged
// savedAsTemplate:true (see PATCH /api/campaigns/[id]), across every user.
// Distinct from /api/admin/campaign-templates (the system-owned "Ready-made
// templates" group): this is the admin's REVIEW list — see who saved what,
// then promote one worth sharing into the general group via the [id]/promote
// route below. Promoting never edits or deletes the user's own row.
export async function GET() {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.emailCampaign.findMany({
    where: { savedAsTemplate: true },
    include: {
      user: { select: { email: true } },
      variants: { select: { id: true, subject: true, bodyHtml: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerEmail: r.user.email,
      variants: r.variants,
      promotedTemplateId: r.promotedTemplateId,
      createdAt: r.createdAt,
    })),
  );
}
