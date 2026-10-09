import { NextResponse } from "next/server";

import { getAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

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
export async function GET() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const users = await prisma.user.findMany({
    select: { id: true, email: true },
    orderBy: { email: "asc" },
  });
  return NextResponse.json({ ok: true, count: users.length, users });
}
