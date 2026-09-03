import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

// Fixed page size — paginate instead of loading the whole audit log at once.
const PAGE_SIZE = 20;

// GET /api/admin/notifications?page=1&outcome=all|sent|failed
// NotificationLog rows, most recent first, paginated. `outcome` filters the
// list (all / sent / failed) and is optional.
export async function GET(request: Request) {
  const isAdmin = await requireAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const rawPage = Number(searchParams.get("page"));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const outcome = searchParams.get("outcome");
  const where =
    outcome === "sent" || outcome === "failed" ? { outcome } : {};

  const [total, logs] = await Promise.all([
    prisma.notificationLog.count({ where }),
    prisma.notificationLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  return NextResponse.json({
    logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
    total,
    page,
    pageSize: PAGE_SIZE,
  });
}