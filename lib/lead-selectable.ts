import "server-only";

import { prisma } from "@/lib/prisma";

// Task 37 — shared single source for the "pick a finished lead source" data.
// Previously this query/shape lived inline in GET /api/leads/selectable (Task
// 26, Piece 4) and was consumed by the Campaigns picker. The agent turn's
// `list_lead_sources` tool needs the EXACT same data as an inline widget, so
// the types and the fetch live here once and both callers reuse it — the agent
// never re-derives a parallel shape.
//
// PickerJob is the per-job row the Campaigns dropdown labels ("N valid"). A job
// with zero valid leads is shown (grayed) so the user understands *why* it
// isn't selectable, mirroring the Campaigns picker.

export interface PickerJob {
  id: string;
  query: string;
  template: string;
  params: unknown;
  totalCount: number;
  validCount: number;
}

export interface PickerLead {
  id: string;
  email: string | null;
  businessName: string | null;
  contactName: string | null;
  searchJobId: string;
}

export interface PickerData {
  jobs: PickerJob[];
  leads: PickerLead[];
}

export async function fetchSelectableData(userId: string): Promise<PickerData> {
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
  const validByJob = new Map<string, number>(validCounts.map((g) => [g.searchJobId, g._count._all]));

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

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      query: j.query,
      template: j.template,
      params: j.params,
      totalCount: j._count.leads,
      validCount: validByJob.get(j.id) ?? 0,
    })),
    leads,
  };
}