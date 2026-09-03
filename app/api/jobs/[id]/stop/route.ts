import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
  });

  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (job.status !== "queued" && job.status !== "running") {
    return NextResponse.json({ error: "Job is not stoppable" }, { status: 400 });
  }

  await prisma.searchJob.update({
    where: { id },
    data: { status: "failed", error: "Cancelled by user" },
  });

  if (job.workerJobId && process.env.WORKER_BASE_URL) {
    fetch(`${process.env.WORKER_BASE_URL}/jobs/${job.workerJobId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${process.env.WORKER_AUTH_TOKEN}` },
    }).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
