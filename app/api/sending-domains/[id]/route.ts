import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { removeRelayDkimKey } from "@/lib/sending-domains";

// TASK_139 — remove a sending domain, including its key on the relay.
//
// Order matters: the relay entry goes first. If the DB row were deleted first
// and the relay removal then failed, the relay would keep an entry signing for a
// domain no user can see or remove any more — and a later account could not
// register that domain because the stale relay entry would still collide.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params; // MUST await — async in Next.js 16
  const row = await prisma.sendingDomain.findFirst({
    where: { id, userId: session.userId },
    select: { id: true, domain: true, selector: true },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let relayWarning: string | null = null;
  try {
    await removeRelayDkimKey({ domain: row.domain, selector: row.selector });
  } catch (err) {
    // Not fatal to the user's intent (they want it gone from this account), but
    // it must not be silent: an unremoved relay key keeps signing for a domain
    // nothing here tracks any more.
    relayWarning = err instanceof Error ? err.message : String(err);
  }

  await prisma.sendingDomain.delete({ where: { id: row.id } });

  return NextResponse.json({ ok: true, relayWarning });
}
