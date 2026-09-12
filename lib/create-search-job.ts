import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Task 27, Part B — the ONE shared SearchJob + JobQueueEntry creation path,
// extracted verbatim from the tail of POST /api/jobs so an automation's extract
// run and the Extract page submit go through identical code. It expects the
// caller to have already validated/normalized params and resolved the lane the
// same way the route does; this helper only owns the atomic enqueue transaction.
export interface CreateSearchJobInput {
  userId: string;
  query: string;
  template: string;
  params: Prisma.InputJsonValue;
  lane: string;
  priorityTier: number;
}

export async function createSearchJob(input: CreateSearchJobInput): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const searchJob = await tx.searchJob.create({
      data: {
        userId: input.userId,
        query: input.query,
        template: input.template,
        params: input.params,
        lane: input.lane,
        status: "queued",
      },
      select: { id: true },
    });
    await tx.jobQueueEntry.create({
      data: {
        searchJobId: searchJob.id,
        priorityTier: input.priorityTier,
        lane: input.lane,
        status: "queued",
      },
    });
    return searchJob;
  });
}