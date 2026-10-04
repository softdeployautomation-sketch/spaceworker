import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";

// TASK_157 Phase 4b — the user chooser for "add a domain on someone's behalf".
//
// WHY THIS EXISTS. The admin Domains POST route REQUIRES an `ownerUserId`, and it
// rejects an unknown one (that row would be invisible and undeletable by its owner).
// Without a way to LIST users the admin would have to paste a raw cuid into a text
// box, which guarantees the typo class of bug the route exists to prevent.
//
// DELIBERATELY MINIMAL. This returns id + email + tier and nothing else. It is NOT
// the admin Users tab's data source, and it deliberately does not expose tokens,
// balances, node access, sessions, or anything else — adding a domain must not
// become a second, wider window onto a user's account.
//
// BOUNDED. `limit` is capped server-side, so this cannot be turned into a full
// account dump by a crafted query string. Search is a prefix match on email, which
// is what a chooser needs ("find the person whose address starts with…") and is
// indexed enough for an account table of this size.
export async function GET(request: Request) {
  if (!(await requireAdminSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);

  const users = await prisma.user.findMany({
    where: q ? { email: { startsWith: q, mode: "insensitive" } } : {},
    select: { id: true, email: true, tier: true },
    orderBy: { email: "asc" },
    take: limit,
  });

  return NextResponse.json({ users });
}
