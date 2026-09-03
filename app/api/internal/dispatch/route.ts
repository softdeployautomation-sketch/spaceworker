import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const LANES = ["light", "heavy"] as const;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.INTERNAL_BEARER_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const workerBase = process.env.WORKER_BASE_URL;
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  const results: Record<string, unknown> = {};

  // Phase A: dispatch one queued job per idle lane
  for (const lane of LANES) {
    const running = await prisma.searchJob.count({
      where: { lane, status: "running" },
    });

    if (running > 0) {
      results[`${lane}_dispatch`] = "lane_busy";
      continue;
    }

    const entry = await prisma.jobQueueEntry.findFirst({
      where: { lane, status: "queued" },
      orderBy: [{ priorityTier: "desc" }, { createdAt: "asc" }],
      include: { searchJob: true },
    });

    if (!entry) {
      results[`${lane}_dispatch`] = "queue_empty";
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.jobQueueEntry.update({
        where: { id: entry.id },
        data: { status: "dispatched" },
      });
      await tx.searchJob.update({
        where: { id: entry.searchJobId },
        data: { status: "running" },
      });
    });

    if (!workerBase || !workerToken) {
      results[`${lane}_dispatch`] = "no_worker_config";
      continue;
    }

    try {
      const res = await fetch(`${workerBase}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerToken}`,
        },
        body: JSON.stringify({
          jobId: entry.searchJob.id,
          query: entry.searchJob.query,
          params: entry.searchJob.params,
          lane,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { jobId?: string };
        if (data.jobId) {
          await prisma.searchJob.update({
            where: { id: entry.searchJobId },
            data: { workerJobId: data.jobId },
          });
        }
        results[`${lane}_dispatch`] = "dispatched";
      } else {
        await prisma.searchJob.update({
          where: { id: entry.searchJobId },
          data: { status: "failed", error: `Worker rejected: ${res.status}` },
        });
        results[`${lane}_dispatch`] = `worker_error_${res.status}`;
      }
    } catch (err) {
      await prisma.searchJob.update({
        where: { id: entry.searchJobId },
        data: { status: "failed", error: String(err) },
      });
      results[`${lane}_dispatch`] = "worker_unreachable";
    }
  }

  // Phase B: poll running jobs for completion
  const runningJobs = await prisma.searchJob.findMany({
    where: { status: "running", workerJobId: { not: null } },
  });

  let completed = 0;
  let failed = 0;

  for (const job of runningJobs) {
    if (!workerBase || !workerToken || !job.workerJobId) continue;

    try {
      const res = await fetch(`${workerBase}/jobs/${job.workerJobId}`, {
        headers: { Authorization: `Bearer ${workerToken}` },
      });

      if (!res.ok) continue;

      const data = (await res.json()) as {
        status?: string;
        leads?: Array<{
          email?: string; phone?: string; contactName?: string;
          businessName?: string; website?: string; sourceUrl?: string; snippet?: string;
        }>;
        error?: string;
      };

      if (data.status === "done") {
        if (Array.isArray(data.leads) && data.leads.length > 0) {
          await prisma.lead.createMany({
            data: data.leads.map((l) => ({
              userId: job.userId,
              searchJobId: job.id,
              email: l.email ?? null,
              phone: l.phone ?? null,
              contactName: l.contactName ?? null,
              businessName: l.businessName ?? null,
              website: l.website ?? null,
              sourceUrl: l.sourceUrl ?? null,
              snippet: l.snippet ?? null,
            })),
            skipDuplicates: true,
          });
        }
        await prisma.searchJob.update({
          where: { id: job.id },
          data: { status: "done" },
        });
        completed++;
      } else if (data.status === "failed") {
        await prisma.searchJob.update({
          where: { id: job.id },
          data: { status: "failed", error: data.error ?? "Worker reported failure" },
        });
        failed++;
      }
    } catch {
      // Skip — will retry on next tick
    }
  }

  results.phase_b = { completed, failed, checked: runningJobs.length };
  return NextResponse.json(results);
}
