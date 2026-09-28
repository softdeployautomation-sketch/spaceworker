import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";

// PATCH /api/admin/users/[id]/node-access — body: { restricted: boolean }
// Toggles User.nodeAccessRestricted — an override independent of tier. This
// only ever affects SpaceWorker exit-node access (regional mailbox send,
// private-browser proxy, extraction routing); every other premium feature is
// untouched.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params; // MUST await — async in Next.js 16

  let body: { restricted?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.restricted !== "boolean") {
    return NextResponse.json({ error: "restricted must be a boolean" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id },
    data: { nodeAccessRestricted: body.restricted },
    select: { id: true, email: true, tier: true, nodeAccessRestricted: true },
  });

  return NextResponse.json(user);
}
