import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { ensureSystemTemplatesOwner, resolveSystemTemplatesOwnerId } from "@/lib/campaign-templates";

// Task 28, item 5 — admin authoring of "ready-made" campaign templates. A
// template is an EmailCampaign owned by the configured SYSTEM_TEMPLATES_USER_EMAIL
// account, with its subject/body in 1+ CampaignVariant rows and status "draft"
// (so it can never be picked up by the drain/send path). No queue items — a
// template is a subject/body container that gets CLONED per run, never sent
// directly. Gate is the admin session (shared passcode), same as every other
// /api/admin/** route.

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

// GET /api/admin/campaign-templates — system-owned ready-made templates.
export async function GET() {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const ownerId = await resolveSystemTemplatesOwnerId();
  // No ready-made-template account configured yet: return empty (the admin panel
  // shows a hint) instead of erroring.
  if (!ownerId) return NextResponse.json([]);
  const templates = await prisma.emailCampaign.findMany({
    where: { userId: ownerId },
    include: { variants: { orderBy: { createdAt: "asc" }, select: { id: true, subject: true, bodyHtml: true } } },
    orderBy: { name: "asc" },
  });
  return NextResponse.json(templates);
}

// POST /api/admin/campaign-templates  body: { name, variants: [{ subject, bodyHtml }] }
export async function POST(req: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let body: { name?: unknown; variants?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const variants = sanitizeVariants(body.variants);
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (variants.length === 0) {
    return NextResponse.json(
      { error: "At least one subject/body variant is required" },
      { status: 400 },
    );
  }

  const ownerId = await ensureSystemTemplatesOwner();

  const template = await prisma.$transaction(async (tx) => {
    const campaign = await tx.emailCampaign.create({
      data: {
        userId: ownerId,
        name,
        subject: "",
        bodyHtml: "",
        status: "draft", // never sendable directly — only ever cloned
        mailboxIds: [],
        rotateEvery: 1,
      },
      select: { id: true, name: true, createdAt: true },
    });
    await tx.campaignVariant.createMany({
      data: variants.map((v) => ({ campaignId: campaign.id, subject: v.subject, bodyHtml: v.bodyHtml })),
    });
    return campaign;
  });

  return NextResponse.json(template, { status: 201 });
}