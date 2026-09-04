import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

const TEMPLATES = ["lead", "hr", "plain"] as const;
type Template = (typeof TEMPLATES)[number];

function isTemplate(value: unknown): value is Template {
  return typeof value === "string" && (TEMPLATES as readonly string[]).includes(value);
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobs = await prisma.searchJob.findMany({
    where: { userId: session.userId },
    select: {
      id: true, query: true, template: true, params: true, status: true,
      lane: true, error: true, createdAt: true,
      _count: { select: { leads: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(jobs);
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    query?: unknown; queries?: unknown; template?: unknown; params?: unknown; lane?: unknown;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const lane = body.lane === "heavy" ? "heavy" : "light";

  // The multi-item "Find" list is the real shape now (Task 11): a user adds
  // "plumber", "carpenter", ... as separate chips. Accept either `queries: string[]`
  // (preferred) or a single legacy `query` string.
  const queryList: string[] = [];
  if (Array.isArray(body.queries)) {
    for (const q of body.queries) {
      if (typeof q === "string" && q.trim()) queryList.push(q.trim());
    }
  }
  if (typeof body.query === "string" && body.query.trim()) {
    queryList.push(body.query.trim());
  }
  const uniqueQueries = [...new Set(queryList)];
  if (uniqueQueries.length === 0) {
    return NextResponse.json({ error: "At least one search term is required" }, { status: 400 });
  }

  const template = isTemplate(body.template) ? body.template : "lead";
  if (template !== "lead") {
    // HR/Plain Search have no automation backend yet (per PLAN.md Addendum 5 they
    // need their own pipeline, not this lead engine). Refuse to run the lead engine
    // against their input — never silently run the wrong engine.
    return NextResponse.json(
      { error: `The "${template}" template is coming soon and cannot be submitted yet.` },
      { status: 400 }
    );
  }

  const rawParams =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const engine = rawParams.engine === "google" ? "google" : "ddg";

  // Clamp maxResults server-side. Accept number or numeric string. Google runs in
  // the heavy lane (it needs a real browser); DDG is the light lane.
  const rawMax = rawParams.maxResults;
  const coercedMax =
    typeof rawMax === "number" ? rawMax
    : typeof rawMax === "string" && rawMax.trim() !== "" ? Number(rawMax)
    : undefined;
  const maxResults =
    coercedMax !== undefined && !isNaN(coercedMax)
      ? Math.min(Math.max(10, coercedMax), 200)
      : undefined;

  const params = {
    engine,
    ...(maxResults !== undefined ? { maxResults } : {}),
    queries: uniqueQueries,
    template,
  };
  const displayQuery = uniqueQueries.length === 1 ? uniqueQueries[0] : uniqueQueries.join(" | ");
  const resolvedLane = lane === "heavy" || engine === "google" ? "heavy" : "light";

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tier: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.$transaction(async (tx) => {
    const searchJob = await tx.searchJob.create({
      data: {
        userId: session.userId,
        query: displayQuery,
        template,
        params: params as Prisma.InputJsonValue,
        lane: resolvedLane,
        status: "queued",
      },
    });
    await tx.jobQueueEntry.create({
      data: {
        searchJobId: searchJob.id,
        priorityTier: user.tier,
        lane: resolvedLane,
        status: "queued",
      },
    });
    return searchJob;
  });

  return NextResponse.json(job, { status: 201 });
}