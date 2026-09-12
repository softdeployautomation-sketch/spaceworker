import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 26, Piece 4 — picker data for the campaign "Pick from my leads" flow.
// GET /api/leads/selectable  (auth-gated)
//
// Returns everything the picker UI needs in one round trip:
//   jobs:  the user's recent extraction/upload SearchJobs, each with its total
//          lead count and its validationStatus="valid" count (so the dropdown can
//          show "N valid" and gray out jobs with nothing valid to select).
//   leads: every one of the user's VALID leads (id/email/names/searchJobId), so the
//          picker can offer "select all valid across everything" without a second call.
//
// This is a read-only convenience endpoint; the WRITE side (from-leads) re-validates
// ownership + validity server-side and never trusts what the client filtered to.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = session.userId;

  const jobs = await prisma.searchJob.findMany({
    where: { userId },
    select: {
      id: true,
      query: true,
      template: true,
      params: true,
      _count: { select: { leads: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const validCounts = await prisma.lead.groupBy({
    by: ["searchJobId"],
    where: { userId, validationStatus: "valid" },
    _count: { _all: true },
  });
  const validByJob = new Map<string, number>(
    validCounts.map((g) => [g.searchJobId, g._count._all]),
  );

  const leads = await prisma.lead.findMany({
    where: { userId, validationStatus: "valid", email: { not: null } },
    select: {
      id: true,
      email: true,
      businessName: true,
      contactName: true,
      searchJobId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    jobs: jobs.map((j) => ({
      id: j.id,
      query: j.query,
      template: j.template,
      params: j.params,
      totalCount: j._count.leads,
      validCount: validByJob.get(j.id) ?? 0,
    })),
    leads,
  });
}