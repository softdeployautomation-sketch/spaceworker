import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const jobs = await prisma.searchJob.findMany({
    where: { userId: session.userId },
    select: {
      id: true, query: true, params: true, status: true,
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

  let body: { query?: unknown; params?: unknown; lane?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const lane = body.lane === "heavy" ? "heavy" : "light";
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? body.params
      : {};

  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tier: true },
  });
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.$transaction(async (tx) => {
    const searchJob = await tx.searchJob.create({
      data: { userId: session.userId, query, params, lane, status: "queued" },
    });
    await tx.jobQueueEntry.create({
      data: {
        searchJobId: searchJob.id,
        priorityTier: user.tier,
        lane,
        status: "queued",
      },
    });
    return searchJob;
  });

  return NextResponse.json(job, { status: 201 });
}
