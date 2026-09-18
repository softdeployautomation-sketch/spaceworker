import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { stopSearchJob } from "@/lib/job-stop";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Ownership stays scoped here (this specific caller's own account) — the
  // shared stopSearchJob() helper below is deliberately user-agnostic so the
  // admin stop route can reuse the same cancel logic for any customer's job.
  const owned = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await stopSearchJob(id);
  if (result.outcome === "not_stoppable") {
    return NextResponse.json({ error: "Job is not stoppable" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
