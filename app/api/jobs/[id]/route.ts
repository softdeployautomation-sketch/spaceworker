import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    include: {
      leads: {
        select: {
          id: true, email: true, phone: true, contactName: true,
          businessName: true, website: true, sourceUrl: true, snippet: true, createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job);
}

// DELETE /api/jobs/[id] — removes a job run and its leads/queue entry from the
// list. Blocked while "running" (stop it first) so a delete can't orphan an
// in-flight worker job with nothing left to poll or clean it up.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  const job = await prisma.searchJob.findFirst({ where: { id, userId: session.userId } });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.status === "running") {
    return NextResponse.json({ error: "Stop the job before deleting it." }, { status: 409 });
  }

  // No onDelete: Cascade on JobQueueEntry/Lead -> SearchJob, so delete children
  // first inside one transaction (all-or-nothing, avoids an FK error leaving
  // a half-deleted job).
  await prisma.$transaction([
    prisma.jobQueueEntry.deleteMany({ where: { searchJobId: id } }),
    prisma.lead.deleteMany({ where: { searchJobId: id } }),
    prisma.searchJob.delete({ where: { id } }),
  ]);

  return NextResponse.json({ ok: true });
}
