import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 27, Part B — list + create saved CampaignAutomation configs.
// The HARD GATE from Task 09 is enforced here at CREATE time, not at run time:
// a valid campaign template AND at least one sending mailbox are both required
// to even save a configuration.

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

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const automations = await prisma.campaignAutomation.findMany({
    where: { userId: session.userId },
    include: {
      runs: { orderBy: { startedAt: "desc" }, take: 1, select: { id: true, status: true, startedAt: true } },
      _count: { select: { runs: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(automations);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

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

  // ---- HARD GATE #1: campaign template must exist and be the user's own ----
  const template = await prisma.emailCampaign.findFirst({
    where: { id: campaignTemplateId, userId: session.userId },
    select: { id: true, _count: { select: { variants: true } } },
  });
  if (!template || template._count.variants === 0) {
    return NextResponse.json(
      { error: "Choose a campaign template that has at least one subject/body variant." },
      { status: 400 },
    );
  }

  // ---- HARD GATE #2: at least one sending mailbox, all owned by the user ----
  if (mailboxIds.length === 0) {
    return NextResponse.json({ error: "Select at least one sending mailbox." }, { status: 400 });
  }
  const ownedMailboxCount = await prisma.mailbox.count({
    where: { id: { in: mailboxIds }, userId: session.userId },
  });
  if (ownedMailboxCount !== mailboxIds.length) {
    return NextResponse.json({ error: "One or more selected mailboxes are not yours." }, { status: 400 });
  }

  // Lead-source validation: extraction needs terms; personal-list needs a job.
  if (leadSource === "extract" && findTerms.length === 0) {
    return NextResponse.json({ error: "Add at least one Find term for the extract source." }, { status: 400 });
  }
  if (leadSource === "personal_list") {
    const uploadJob = await prisma.searchJob.findFirst({
      where: { id: personalListId ?? "", userId: session.userId, template: "upload" },
      select: { id: true },
    });
    if (!uploadJob) {
      return NextResponse.json({ error: "Pick one of your uploaded lead lists." }, { status: 400 });
    }
  }
  if (triggerMode === "daily" && scheduleHour === null) {
    return NextResponse.json({ error: "Daily automations need a schedule hour (0-23 UTC)." }, { status: 400 });
  }

  // Extraction params are stored verbatim (engine/limits/etc.) — validated at the
  // job-creation boundary on each run, same as POST /api/jobs does today.
  const params: Prisma.InputJsonValue =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (JSON.parse(JSON.stringify(body.params)) as Prisma.InputJsonValue)
      : {};

  const automation = await prisma.campaignAutomation.create({
    data: {
      userId: session.userId,
      name,
      leadSource,
      findTerms,
      locationTerms,
      params,
      personalListId,
      campaignTemplateId,
      mailboxIds,
      triggerMode,
      scheduleHour: triggerMode === "daily" ? scheduleHour : null,
    },
  });

  return NextResponse.json(
    automation,
    { status: 201 },
  );
}