import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { usableTemplateWhere } from "@/lib/campaign-templates";

// Task 27, Part B — edit / pause-resume / delete a saved automation.
// Editing re-runs the same hard gate as create (template + >=1 mailbox), so an
// edit can't quietly turn a valid config into one that can't actually run.
// Pause/Resume are lightweight actions that only flip scheduleEnabled for daily
// automations (the user's own automation is untouched and runs stay intact).

function sanitizeStringArray(value: unknown, max = 300): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      if (out.length >= max) break;
    }
  }
  return out;
}

function parseMailboxIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((m) => String(m).trim()).filter((m) => m.length > 0))];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const automation = await prisma.campaignAutomation.findFirst({
    where: { id, userId: session.userId },
    include: { runs: { orderBy: { startedAt: "desc" }, take: 20 } },
  });
  if (!automation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(automation);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const existing = await prisma.campaignAutomation.findFirst({ where: { id, userId: session.userId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Lightweight pause / resume first — no gate revalidation needed.
  if (body.action === "pause") {
    return NextResponse.json(
      await prisma.campaignAutomation.update({ where: { id }, data: { scheduleEnabled: false } }),
    );
  }
  if (body.action === "resume") {
    return NextResponse.json(
      await prisma.campaignAutomation.update({ where: { id }, data: { scheduleEnabled: true } }),
    );
  }

  // ---- Full edit: same hand-off-independent validation as create ----
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const leadSource = body.leadSource === "personal_list" ? "personal_list" : "extract";
  const findTerms = sanitizeStringArray(body.findTerms);
  const locationTerms = sanitizeStringArray(body.locationTerms);
  const mailboxIds = parseMailboxIds(body.mailboxIds);
  const campaignTemplateId = typeof body.campaignTemplateId === "string" ? body.campaignTemplateId.trim() : "";
  const personalListId = leadSource === "personal_list" && typeof body.personalListId === "string" ? body.personalListId.trim() : null;
  const triggerMode = body.triggerMode === "daily" ? "daily" : "manual";
  const rawHour = Number(body.scheduleHour);
  const scheduleHour = Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : null;

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });

  const template = await prisma.emailCampaign.findFirst({
    where: await usableTemplateWhere(campaignTemplateId, session.userId),
    select: { id: true, _count: { select: { variants: true } } },
  });
  if (!template || template._count.variants === 0) {
    return NextResponse.json(
      { error: "Choose a campaign template that has at least one subject/body variant." },
      { status: 400 },
    );
  }
  if (mailboxIds.length === 0) {
    return NextResponse.json({ error: "Select at least one sending mailbox." }, { status: 400 });
  }
  const ownedMailboxCount = await prisma.mailbox.count({
    where: { id: { in: mailboxIds }, userId: session.userId },
  });
  if (ownedMailboxCount !== mailboxIds.length) {
    return NextResponse.json({ error: "One or more selected mailboxes are not yours." }, { status: 400 });
  }
  if (leadSource === "extract" && findTerms.length === 0) {
    return NextResponse.json({ error: "Add at least one Find term for the extract source." }, { status: 400 });
  }
  if (leadSource === "personal_list") {
    const uploadJob = await prisma.searchJob.findFirst({
      where: { id: personalListId ?? "", userId: session.userId, template: "upload" },
      select: { id: true },
    });
    if (!uploadJob) return NextResponse.json({ error: "Pick one of your uploaded lead lists." }, { status: 400 });
  }
  if (triggerMode === "daily" && scheduleHour === null) {
    return NextResponse.json({ error: "Daily automations need a schedule hour (0-23 UTC)." }, { status: 400 });
  }

  const bodyParams: Prisma.InputJsonValue =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (JSON.parse(JSON.stringify(body.params)) as Prisma.InputJsonValue)
      : {};

  const updated = await prisma.campaignAutomation.update({
    where: { id },
    data: {
      name,
      leadSource,
      findTerms,
      locationTerms,
      params: bodyParams,
      personalListId,
      campaignTemplateId,
      mailboxIds,
      triggerMode,
      scheduleHour: triggerMode === "daily" ? scheduleHour : null,
    },
  });

  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const existing = await prisma.campaignAutomation.findFirst({ where: { id, userId: session.userId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.$transaction([
    prisma.campaignAutomationRun.deleteMany({ where: { automationId: id } }),
    prisma.campaignAutomation.delete({ where: { id } }),
  ]);

  return NextResponse.json({ ok: true });
}