import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/admin-auth";
import { isPremiumTier } from "@/lib/trial";

// GET /api/admin/node-access — every user who CAN reach SpaceWorker's exit
// nodes (premium tier), whether they're currently restricted, and whether
// they're actually USING a node right now: a mailbox with a sendRegion set,
// or a currently-running private-browser session actually routed through one
// (proxyMode "free" with a real exitNodeId — "free" with no exitNodeId is a
// direct connection, not node use, same distinction the route-level gates use).
export async function GET() {
  const isAdmin = await getAdminSession();
  if (!isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      tier: true,
      nodeAccessRestricted: true,
      mailboxes: { where: { sendRegion: { not: null } }, select: { id: true, label: true, sendRegion: true } },
      browserSessions: {
        where: { status: "running", proxyMode: "free", exitNodeId: { not: null } },
        select: { id: true, exitNodeId: true },
      },
    },
    orderBy: { email: "asc" },
  });

  const rows = users
    .map((u) => ({
      id: u.id,
      email: u.email,
      premium: isPremiumTier(u.tier),
      restricted: u.nodeAccessRestricted,
      usingMailboxRegions: u.mailboxes.map((m) => ({ label: m.label, region: m.sendRegion })),
      usingBrowserNodes: u.browserSessions.map((s) => s.exitNodeId),
    }))
    // Only surface users who are either premium (can access) or currently
    // using a node somehow (shouldn't happen without premium, but a tier
    // downgrade could leave a stale sendRegion on a mailbox — worth showing,
    // not hiding, exactly the kind of state this tab exists to surface).
    .filter((u) => u.premium || u.usingMailboxRegions.length > 0 || u.usingBrowserNodes.length > 0);

  return NextResponse.json({ users: rows });
}
