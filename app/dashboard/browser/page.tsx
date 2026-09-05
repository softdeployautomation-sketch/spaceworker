import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { listExitNodes } from "@/lib/exit-nodes";
import { connectUrlFor } from "@/lib/browser-session-serialize";
import BrowserSessionPanel from "@/components/browser-session-panel";

export default async function BrowserPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [user, profiles, sessions] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.userId }, select: { tier: true } }),
    prisma.browserProfile.findMany({
      where: { userId: session.userId },
      select: {
        id: true,
        name: true,
        status: true,
        byoProxyHost: true,
        byoProxyPort: true,
        byoProxyScheme: true,
        byoProxyUsername: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.browserSession.findMany({
      where: { userId: session.userId, hiddenAt: null },
      select: {
        id: true,
        status: true,
        proxyMode: true,
        exitNodeId: true,
        byoProxyUsername: true,
        containerId: true,
        nekoPassword: true,
        startedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  if (!user) redirect("/login");

  return (
    <BrowserSessionPanel
      tier={user.tier}
      exitNodes={listExitNodes().map((n) => ({
        id: n.id,
        city: n.city,
        country: n.country,
        flag: n.flag,
      }))}
      initialProfiles={profiles.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status as "idle" | "in_use",
        byoHost: p.byoProxyHost,
        byoPort: p.byoProxyPort,
        byoScheme: p.byoProxyScheme,
        byoUser: p.byoProxyUsername,
      }))}
      initialSessions={sessions.map((s) => ({
        id: s.id,
        status: s.status,
        proxyMode: s.proxyMode,
        exitNodeId: s.exitNodeId,
        byoUser: s.byoProxyUsername,
        startedAt: s.startedAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        connectUrl: s.status === "running" ? connectUrlFor(s.id, s.nekoPassword) : null,
      }))}
    />
  );
}