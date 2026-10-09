import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { deriveUserPresence } from "@/lib/user-presence";

export const dynamic = "force-dynamic";

// TASK_188 S3 — GET /api/admin/users
//
// The minimal admin user list: id + email, alphabetically. It exists for ONE
// purpose — the Recover picker on the Deleted devices subtab ("recover to any
// user I choose"), which needs every user, not just the premium ones.
//
// (Deliberately NOT reusing /api/admin/node-access: that route filters to
// premium/node-using users, and a deleted device can belong to anyone.
// /api/admin/users/[id]/* are per-user mutations; there was no list endpoint.)
//
// Read-only, admin session asserted by this route itself (app/api/admin/**
// rule). No tier/expires/usage fields — none of the three is needed to pick a
// person, and the least data exposed the better.
//
// TASK_190 S5 — ADDS presence: the derived chip + the raw stamps the Users
// tab renders ("idle Xm" comes from lastActiveAt, page detail from
// lastSeenPage). Derived here with the SAME lib helper the devices list and
// the heartbeat use, so the two admin tabs can never disagree. The chat-id-
// style rule applies to none of these: last-seen stamps are operational data
// the admin panel already shows per device.
export async function GET() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const now = new Date();
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      lastSeenAt: true,
      lastActiveAt: true,
      lastSeenPage: true,
    },
    orderBy: { email: "asc" },
  });
  return NextResponse.json({
    ok: true,
    count: users.length,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      presence: deriveUserPresence(u.lastActiveAt, u.lastSeenAt, now),
      lastSeenAt: u.lastSeenAt ? u.lastSeenAt.toISOString() : null,
      lastActiveAt: u.lastActiveAt ? u.lastActiveAt.toISOString() : null,
      lastSeenPage: u.lastSeenPage,
    })),
  });
}
