import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

// Task 26, Piece 7c — discard the invalid leads in a job after validation.
// POST /api/jobs/[id]/leads/delete-invalid
// Deletes every lead in the job whose validationStatus is "invalid" — the valid
// ones and the still-unchecked / no-email ones are left completely untouched (a
// job that was validated, then a few new unchecked leads appeared, keeps those).
// Returns how many rows were removed so the UI can react.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  // Same ownership pattern as the other job routes: a job that belongs to someone
  // else reads as 404 (don't leak existence).
  const job = await prisma.searchJob.findFirst({
    where: { id, userId: session.userId },
    select: { id: true },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const deleted = await prisma.lead.deleteMany({
    where: { searchJobId: id, userId: session.userId, validationStatus: "invalid" },
  });

  return NextResponse.json({ deleted: deleted.count });
}