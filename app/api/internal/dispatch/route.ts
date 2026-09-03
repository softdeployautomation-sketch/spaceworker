import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const LANES = ["light", "heavy"] as const;

// Stable integer IDs for PostgreSQL advisory locks — one per lane.
// pg_advisory_xact_lock holds the lock until the transaction commits/rolls
// back, so two concurrent dispatch calls for the same lane serialize
// rather than racing through the count+claim sequence.
const LANE_LOCK_ID: Record<string, number> = { light: 1001, heavy: 1002 };

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
    // Guard worker config before touching the DB — avoids jobs stuck "running"
    // with no workerJobId when the env vars are missing.
    if (!workerBase || !workerToken) {
      results[`${lane}_dispatch`] = "no_worker_config";
      continue;
    }

    // The lane-busy count and the row claim are inside one transaction guarded
    // by a PostgreSQL advisory lock. This prevents two concurrent dispatch
    // calls from each seeing running=0 independently and then each claiming a
    // different queued entry — which would violate the single-concurrency
    // invariant for each lane.
    const claimed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LANE_LOCK_ID[lane]})`;

      const running = await tx.searchJob.count({ where: { lane, status: "running" } });
      if (running > 0) return "lane_busy" as const;

      const entry = await tx.jobQueueEntry.findFirst({
        where: { lane, status: "queued" },
        orderBy: [{ priorityTier: "desc" }, { createdAt: "asc" }],
        include: { searchJob: true },
      });
      if (!entry) return null;

      const { count } = await tx.jobQueueEntry.updateMany({
        where: { id: entry.id, status: "queued" },
        data: { status: "dispatched" },
      });
      if (count === 0) return null;

      await tx.searchJob.update({
        where: { id: entry.searchJobId },
        data: { status: "running" },
      });
      return entry;
    });

    if (claimed === "lane_busy") {
      results[`${lane}_dispatch`] = "lane_busy";
      continue;
    }

    if (!claimed) {
      results[`${lane}_dispatch`] = "queue_empty";
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
          jobId: claimed.searchJob.id,
          query: claimed.searchJob.query,
          params: claimed.searchJob.params,
          lane,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { jobId?: string };
        if (!data.jobId) {
          // Worker returned 200 but no jobId — treat as failure so the job
          // doesn't get stuck "running" forever with nothing to poll.
          await prisma.searchJob.update({
            where: { id: claimed.searchJobId },
            data: { status: "failed", error: "Worker returned no jobId" },
          });
          results[`${lane}_dispatch`] = "worker_missing_jobid";
        } else {
          await prisma.searchJob.update({
            where: { id: claimed.searchJobId },
            data: { workerJobId: data.jobId },
          });
          results[`${lane}_dispatch`] = "dispatched";
        }
      } else {
        await prisma.searchJob.update({
          where: { id: claimed.searchJobId },
          data: { status: "failed", error: `Worker rejected: ${res.status}` },
        });
        results[`${lane}_dispatch`] = `worker_error_${res.status}`;
      }
    } catch (err) {
      await prisma.searchJob.update({
        where: { id: claimed.searchJobId },
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
