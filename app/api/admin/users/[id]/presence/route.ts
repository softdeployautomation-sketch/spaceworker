import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { listUserPresenceEvents, PRESENCE_LIST_LIMIT } from "@/lib/user-presence";

export const dynamic = "force-dynamic";

// GET /api/admin/users/[id]/presence — TASK_190 S5, the activity drawer's
// feed: the user's recent UserPresenceEvent rows, newest first, capped at
// PRESENCE_LIST_LIMIT (100) over a rolling 7-day window (verify §4.4).
//
// Admin session asserted here (403, matching the sibling /api/admin/users/*
// routes). Unknown user ⇒ 404 — the same deep-404 posture the device routes
// use: an id that maps to nobody is "not found", never an empty 200 that
// would confirm id-guessing.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params; // MUST await — async in Next.js 16

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = await listUserPresenceEvents(id, PRESENCE_LIST_LIMIT, since);
  return NextResponse.json({
    ok: true,
    events: events.map((e) => ({
      state: e.state,
      page: e.page,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}
