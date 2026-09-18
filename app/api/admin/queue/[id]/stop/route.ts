import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { stopSearchJob } from "@/lib/job-stop";

// POST /api/admin/queue/[id]/stop — admin-scoped per-job stop. Shares the exact
// cancellation with the customer-facing stop route (app/api/jobs/[id]/stop)
// via stopSearchJob(), but is gated by the admin session instead of a
// userId-scoped ownership check — an admin can stop any customer's job, which
// is the whole point of surfacing it here (previously the only "stop" was
// killing the whole spaceworker.service, which took every customer down).
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const result = await stopSearchJob(id);

  if (result.outcome === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result.outcome === "not_stoppable") {
    return NextResponse.json({ error: "Job is not stoppable" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}